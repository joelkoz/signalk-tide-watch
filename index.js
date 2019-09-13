const Bacon = require('baconjs');
const { TideAnalyzer, msPhaseLength } = require('./TideAnalysis.js');
const LocationManager = require('./LocationManager.js');
const DBDepthLog = require('./DBDepthLog.js');
const SignalKPlugin = require('./SignalKPlugin.js');


class TideWatchPlugin extends SignalKPlugin {

  constructor(app) {
    super(app, 'signalk-tide-watch', 'Tide Watch', 'Observe tides automatically and predict future tides');

    this.captureLocation = null;

    this.optStr('depthPath', 'Depth measurement SignalK path', 'environment.depth.belowSurface');
    this.optStr('depthSourceType', 'Depth source Type filter', '');
    this.optNum('depthSamplesInAverage', 'Number of depth readings in average', 60, false, 'The number of readings in the moving average of depths used for tide phase tracking.');
    this.optStr('depthSourceTalker', 'Depth source Talker filter', '');
    this.optNum('depthDataTimeout', 'Seconds before depth data timeout', 30);
    this.optStr('posPath', 'GPS position SignalK path', 'navigation.position');
    this.optNum('posDataTimeout', 'Seconds before position data timeout', 30);
    this.optStr('engineRPMPath', 'Engine running SignalK path', 'propulsion.1.revolutions');
    this.optNum('recordDataInterval', 'Minutes between depth samples', 5, false, 'The number of minutes between each average depth check when determining tide phase');
    this.optNum('maxLocationDistance', 'Max location distance', 100, false, 'Max meters between two points for them to be considered in the same location.');
  }


/**
   * Create the BaconJS data streams and properties used by this plugin
   */
  onPluginStarted() {

      this.locationManager = new LocationManager(this.dataDir, this.options.maxLocationDistance, this.debug.bind(this));

      // 15 second heartbeat for checking if data has been received.
      var heartbeatInterval = 15000;
      this.evtHeartbeat = Bacon.fromPoll(heartbeatInterval, () => { return this.getTime() });

      this.subscribeVal(this.evtHeartbeat, this.updateStatus );


      // 1 min event - sends a timer out every one minute ------------------------------------------------
      var timerInterval = 60000;
      // timerInterval = 2000;
      // The main timing loop - every 1 minute
      this.evt1min = Bacon.fromPoll(timerInterval, () => { return this.getTime() });


      // Depth soundings ---------------------------------------------------------------------------------
      this.evtDepth = this.getSKBus(this.options.depthPath);

      this.evtDepthVal = this.evtDepth
          .filter(dbs => {  return this.wildcardEq(dbs.source.type, this.options.depthSourceType) &&
                                   this.wildcardEq(dbs.source.talker, this.options.depthSourceTalker); 
                          } )
          .map(".value");

      this.subscribeVal(this.evtDepthVal, depth => {
          this.lastDepthReceived = new Date().getTime();
      });
    
      function moving_avg(list) {
        var sum = list.reduce(function(a, b) { return a + b; }, 0);
        var depth = sum / list.length;
        return Math.floor((depth * 1000.0) + 0.5) / 1000.0;
      }

      this.propAvgDepth = this.evtDepthVal
            .slidingWindow(this.options.depthSamplesInAverage)
            .map(moving_avg)
            .toProperty();

      // this.subscribeVal(this.propAvgDepth, depth => { this.debug(`avgDepth: ${depth}`) } );
      // this.subscribeVal(this.evtDepthVal, depth => { this.debug(`curDepth: ${depth}`) } );
      // this.subscribeVal(this.evtDepth, depth => { this.debug(`depth: ${JSON.stringify(depth, null, 2)}`) } );


      this.evtTidePhase = new Bacon.Bus();
      this.subscribeVal(this.evtTidePhase, data => { this.debug(`Tide phase: ${JSON.stringify(data)}`) } );
      this.subscribeVal(this.evtTidePhase, this.onTidePhase );

      this.tideInfo = new TideAnalyzer(this.evtTidePhase, this.options.recordDataInterval, this.debug.bind(this));

      // GPS Position -------------------------------------------------------------------------------------
      this.evtPos = this.getSKBus(this.options.posPath);

      this.propPos = this.evtPos
          .map(".value")
          .toProperty();

      this.subscribeVal(this.propPos, pos => {
          this.lastPosReceived = this.getTime();
      });

      // this.propPos.onValue(pos => { this.debug(`pos: ${JSON.stringify(pos)}`) } );




      // Engine status ------------------------------------------------------------------------------------
      this.evtEngine = this.getSKBus(this.options.engineRPMPath);

      this.propRPM = this.evtEngine
          .map(".value")
          .toProperty(0);


      this.busEngineOn = new Bacon.Bus();
      this.engineOn = true; // Set this true only so checkForEngineOff() sends initial "engine off"
      this.lastEngineOn = 0;
      this.engineSilentInterval = 15 * 1000;

      function checkForEngineOn(rpm) {
          if (rpm > 0) {
            this.lastEngineOn = this.getTime();
            if (!this.engineOn) {
              this.engineOn = true;
              this.busEngineOn.push(true);
            }
          }
      }
      this.subscribeVal(this.propRPM, checkForEngineOn);

      function checkForEngineOff(timer) {
          if (this.engineOn &&
              (timer - this.lastEngineOn) > this.engineSilentInterval) {
              this.engineOn = false;
              this.busEngineOn.push(false);
          }
      }

      this.subscribeVal(this.evtHeartbeat, checkForEngineOff);

      this.subscribeVal(this.busEngineOn, status => { this.debug(`Main engine is ${( status ? "ON" : "OFF")}`) } );



      // Reaction: Depth recording at anchor --------------------------------------------------------------------------------

      this.evtDataReady = Bacon.combineWith((timer, depth, pos) => { 
                                                  return { timer, depth, pos } 
                                                }, 
                                                this.evt1min, 
                                                this.propAvgDepth, 
                                                this.propPos)
                                  .sampledBy(this.evt1min)
                                  .filter(".depth")
                                  .filter(data => { return this.recordingData; });

      this.propDepthData = this.evtDataReady.toProperty();

      this.subscribeVal(this.propDepthData.sample(timerInterval * this.options.recordDataInterval), this.recordDepth);
      this.subscribeVal(this.propDepthData.sample(timerInterval * this.options.recordDataInterval), this.reportTideHeight);


      // A stream that combines the engine status with the current position
      // which controls the start/stop recording events.
      this.evtRecordStatus = Bacon.combineWith( (engineOn, pos) => { 
                                                        return { engineOn, pos}; 
                                                  },
                                                  this.busEngineOn,
                                                  this.propPos)
                                    .sampledBy(this.busEngineOn);


      this.subscribeVal(this.evtRecordStatus, data => {  if (data.engineOn) {
                                                        this.stopRecording(data);
                                                    }
                                                    else {
                                                        this.startRecording(data);
                                                    }
                                          } );

  }


  onPluginStopped() {
    // Here we do additional cleanup...
    delete this.locationManager;
    delete this.tideInfo;
  };



  // Registers paths that this plugin wants to respond to...
  registerWithRouter(router) {

      this.debug("Registering routes...");
      router.get("/api/status", (req, res) => {
          if (this.running) {
            let j = this.tideInfo.getTideStatus();
            j.recordingData = this.recordingData;
            j.captureLocation = this.captureLocation;
            j.recordingStartedAt = this.recordingStartedAt;
            this.debug(`Returning JSON call ${JSON.stringify(j)}`)
            res.json(j);
          }
          else {
            res.status(503).send('Plugin not running');
          }
      });

      router.put("/api/location", (req, res) => {
          try {
            this.debug("PUT request!")
            let loc = req.body;
            if (this.captureLocation && this.captureLocation.id == loc.id) {
                this.debug(`Location save for: ${JSON.stringify(loc)}`);
                this.locationManager.saveLocation(loc);
                this.captureLocation = loc;
                res.json({ status: "OK" });
            }
            else {
               throw new Error("Save location does not match current location");
            }
          }
          catch (error) {
            this.debug(`Error saving location: ${err}`);
            res.status(500).json({ status: "ERROR", error });
          }
      });
  }
  

  // Updates the status on the admin console
  updateStatus(timer) {
      if (this.startedOn < 0) {
          this.setStatus("Starting...");
      }
      else if ((timer - this.startedOn) > 30000) {

        if (!this.lastDepthReceived ||
              (timer - this.lastDepthReceived) > this.options.depthDataTimeout * 1000) {
              this.setError("No depth data available");
              return;
        }
        else if (!this.lastPosReceived ||
          (timer - this.lastPosReceived) > this.options.posDataTimeout * 1000) {
          this.setError("No position data available");
          return;
        }
      }

      if (this.recordingData) {
          if (!this.tideInfo.curTideDir) {
             this.setStatus("Watching depth for tide phase...");
          }
          else {
            this.setStatus(`Tracking phase '${this.tideInfo.curTidePhase}'`);
          }
      }
      else {
          if (!this.running) {
            this.setStatus("Stopped");
          }
          else {
            this.setStatus("Engine on - not tracking");
          }
      }
     
  }


  
  // Called when recording of depth data should start
  startRecording(data) {

    this.setStatus("Starting depth recording");
    this.debug(`Data recording started for pos ${JSON.stringify(data.pos)}`);

    this.recordingStartedAt = this.getTime();
    this.recordingData = true;
    this.captureLocation = null;

    this.tideInfo.start();

    // Playback any previous data from this location...
    this.setStatus("Playing back data");
    this.playbackLast30Days(data.pos);

    if (this.tideInfo.lastPhaseReport) {

        let _4DaysAgo = this.getTime() - 4 * 24 * 60 * 60 * 1000;

        if (this.tideInfo.lowestKnown.timer &&
            this.tideInfo.lowestKnown.timer < _4DaysAgo) {
            // The lowest known low tide occurred more than 4 days ago,
            // so just forget we even know it...
            this.tideInfo.lowestKnown = {};
        }

        if (this.tideInfo.highestKnown.timer &&
            this.tideInfo.highestKnown.timer < _4DaysAgo) {
            // The highest known tide is more than 4 days ago, so
            // forget we even know it...
            this.tideInfo.highestKnown = {};
        }

        // If the latest known phase occurred within the last seven hours
        // can just report it. Otherwise, we need to start tracking
        // again...
        let _7HoursAgo = this.getTime() - 7 * 60 * 60 * 1000;
        if (this.tideInfo.lastPhaseReport.timer > _7HoursAgo) {
          this.evtTidePhase.push(this.tideInfo.lastPhaseReport);
        }
        else {
           // We need to start the tracking process over...
           this.tideInfo.resetPhaseTracking();
        }
    }

  }

  
  // Called to stop recording depth data
  stopRecording() {
    if (this.recordingData) {
      this.recordingData = false;
      this.recordingStoppedAt = this.getTime();
      this.debug('Data recording ended.');
    }
  }



  // Returns an opened DBDepthLog file to be used for writing depth data.
  // The file should be closed after using it.
  getLogFile(pos) {
      if (this.captureLocation == null) {
        this.captureLocation = this.locationManager.getNearest(pos);
      }
    
      let fileName = this.dataDir + `/${("0000" + this.captureLocation.id).slice(-5)}.dat`;

      let dbLog = new DBDepthLog(this.options.recordDataInterval);
      dbLog.open(fileName);
      dbLog.fileName = fileName;
      return dbLog;
  }




  /**
   * Add the specified data object to the tide analysis, and then record it in the data log
   * @param {object} data {timer, depth, pos }
   */
  recordDepth(data) {

    try {
        this.tideInfo.includeData(data, true);
        var dbLog = this.getLogFile(data.pos);
        dbLog.appendRecord(data);
        dbLog.close();
        this.debug(`Record data: ${data.timer}\t${data.depth}\t${this.tideInfo.curTideDir}\t${data.pos.latitude}\t${data.pos.longitude}`);
    } catch (err) {
       this.debug(err);
    }
  }



  // Play back the last 31 days (or so) of depth
  // information to see if there is any
  // useful interformation. This also prevents
  // a system restart from losing important
  // tracking data.
  playbackLast30Days(pos) {

      let dbLog = this.getLogFile(pos);

      // Ignore entries more than 31 days ago...
      var cutoff = this.getTime();
      cutoff -= 31 * 24 * 60 * 60 * 1000;

      this.debug(`Playing back contents of ${dbLog.fileName}`);

      // If there is a gap of more than 40 minutes in the
      // data, reset the phase tracking to lock in to
      // a new phase...
      const trackingTimoutInterval = 40 * 60 * 1000;
      let lastTimer = 0;

      dbLog.forEach(data => {

          if (data.timer >= cutoff) {
              if (data.timer - lastTimer > trackingTimoutInterval) {
                  // A large data gap - reset the phase tracking...
                  this.tideInfo.resetPhaseTracking();
              }
              this.tideInfo.includeData(data, false);
              lastTimer = data.timer;
          }
          else {
            this.debug(`skipping reccord ${JSON.stringify(data)}`);
          }
      });
      dbLog.close();
      this.debug("Done with playback.");
  }



  
  reportTideHeight(data) {

      if (this.recordingData && this.tideInfo.lastPhaseReport) {

        var phaseData = this.tideInfo.lastPhaseReport;

        let values = [
            { path: "environment.tide.phaseNow", value: `${phaseData.phase}`}
        ];

        // See if we have enough data to estimate the tide height...
        let estTideOffset = this.tideInfo.estimateTideHeightNow(data.timer);
        if (estTideOffset != null) {
            values.push(
              { path: "environment.tide.heightNow", value: estTideOffset}
            );
        }


        this.sendSKValues(values);
      }
  }



  
  // Called whenever a new change in tide phase information is published on the evtTidePhase bus
  onTidePhase(data) {
      // data = { timer: data.timer, phase, lowestKnown: this.lowestKnown, highestKnown: this.highestKnown};

      var values = [
        { path: "environment.tide.phaseNow", value: `${data.phase}`}
      ];


      if (data.lowestKnown.timer) {
          values.push(
              { path: "environment.tide.timeLow", value: this.tideInfo.getFuturePhaseDate(data.lowestKnown.timer).toISOString() }
          );

          values.push(
            { path: "environment.tide.heightLow", value: data.lowestKnown.depth}
          );
      }


      if (data.highestKnown.timer) {
        values.push(
            { path: "environment.tide.timeHigh", value: this.tideInfo.getFuturePhaseDate(data.highestKnown.timer).toISOString() }
        );

        values.push(
          { path: "environment.tide.heightHigh", value: data.highestKnown.depth}
        );
      }

      // See if we have enough data to estimate the tide height...
      let estTideOffset = this.tideInfo.estimateTideHeightNow(data.timer);
      if (estTideOffset != null) {
          values.push(
            { path: "environment.tide.heightNow", value: estTideOffset}
          );
      }

      this.sendSKValues(values);

  }

  // The plugin schema
  // schema() { 
  //   return { type: 'object',
  //             properties: {
  //               depthPath: {
  //                 type: 'string',
  //                 title: 'Depth measurement SignalK path',
  //                 default: 'environment.depth.belowSurface'
  //               },
  //               depthSourceType: {
  //                 type: 'string',
  //                 title: 'Depth source Type filter',
  //                 default: ''
  //               },
  //               depthSamplesInAverage: {
  //                 type: 'number',
  //                 title: 'Number of depth readings in average',
  //                 description: 'The number of readings in the moving average of depths used for tide phase tracking.',
  //                 default: 60
  //               },
  //               depthSourceTalker: {
  //                 type: 'string',
  //                 title: 'Depth source Talker filter',
  //                 default: ''
  //               },
  //               depthDataTimeout: {
  //                 type: 'number',
  //                 title: 'Seconds before depth data timeout',
  //                 default: 30
  //               },
  //               posPath: {
  //                 type: 'string',
  //                 title: 'GPS position SignalK path',
  //                 default: 'navigation.position'
  //               },
  //               posDataTimeout: {
  //                 type: 'number',
  //                 title: 'Seconds before position data timeout',
  //                 default: 30
  //             },
  //               engineRPMPath: {
  //                 type: 'string',
  //                 title: 'Engine running SignalK path',
  //                 default: 'propulsion.1.revolutions'
  //               },
  //               recordDataInterval: {
  //                 type: 'number',
  //                 title: 'Minutes between depth samples',
  //                 description: 'The number of minutes between each average depth check when determining tide phase',
  //                 default: 5
  //               },
  //               maxLocationDistance: {
  //                 type: 'number',
  //                 title: 'Max location distance',
  //                 description: 'Max meters between two points for them to be considered in the same location.',
  //                 default: 100
  //               }
  //             }    
  //           };
  // }



};


module.exports = function (app) {
  var plugin = new TideWatchPlugin(app);
  return plugin;
}