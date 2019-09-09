const Bacon = require('baconjs');
const geolib = require('geolib');
const fs = require('fs');
const CircularFile = require("structured-binary-file").CircularFile;
const Parser = require("binary-parser-encoder").Parser;

// The next tide phase will occur, on average 12 hours 25 minutes after the last phase...
const msPhaseLength = (12 * 60 + 25) * 60 * 1000;

class TideWatchPlugin {

  constructor(app) {

    this.id = 'signalk-tide-watch';
    this.name = 'Tide Watch';
    this.description = 'Observe tides automatically and predict future tides';
    this.app = app;
    this.unsub = [];
    this.captureLocation = null;
    this.locations = null;

    this.maxTideSwitchSlope = 0.00015;

    this.DataLogRecord = Parser.start()
                            .double("timer")
                            .float("depth")
                            .nest("pos", { type: Parser.start()
                                  .double("latitude")
                                  .double("longitude")
                              });

  }

  // 'Subscribes' function f to the stream strm, adding its 'unsubscribe' function
  // to the unsub list.
  subscribeVal(strm, f) {
      this.unsub.push(strm.onValue(f.bind(this)));
  }


  start(options, restartPlugin) {

    this.running = true;
    this.restartPlugin = restartPlugin;

    // Here we put our plugin logic
    this.debug('Tide Watch plugin starting...');
    this.setStatus("Starting...");

    this.startedOn = -1;
    this.setDefaultOptions(options);
    this.debug(`Options: ${JSON.stringify(options)}`);
    this.options = options;


    // Returns TRUE if str does not have any contents (ie. is empty, null or undefined)
    function strEmpty(str) {
      return (!str || 0 === str.trim().length);
    }

    // Returns TRUE if the specified configItem matches the specified configVal. An
    // empty configVal is a wildcard that matches any value of configItem
    function configMatch(configItem, configVal) {
        return (strEmpty(configVal) || configItem == configVal);
    }


    this.dataDir = this.app.getDataDirPath();
    this.debug(`Data dir path is ${this.dataDir}`);


    // 15 second heartbeat for checking if data has been received.
    var heartbeatInterval = 15000;
    this.evtHeartbeat = Bacon.fromPoll(heartbeatInterval, () => { return this.getTime() });

    this.subscribeVal(this.evtHeartbeat, this.updateStatus );


    // 1 min event - sends a timer out every one minute ------------------------------------------------
    var timerInterval = 60000;
    // timerInterval = 2000;
    // The main timing loop - every 1 minute
    this.evt1min = Bacon.fromPoll(timerInterval, () => { return this.getTime() });

    // this.subscribeVal(this.evt1min, timer => { this.debug(`Timer: ${timer}`) } );




    // Check which SignalK paths are available every 15  seconds, and publish when they change ---------
    // this.curPaths =
    // Bacon.fromPoll(15000, () => {
    //           return new Bacon.Next(this.app.streambundle.getAvailablePaths());
    //       })
    //       .skipDuplicates()
    //       .toProperty([]);
          
    // this.subscribeVal(this.curPaths, (paths) => {
    //                                   this.debug('Available paths are:');
    //                                   this.debug(paths)
    //                               });      




    // Depth soundings ---------------------------------------------------------------------------------
    this.evtDepth = this.getSKBus(options.depthPath);

    this.evtDepthVal = this.evtDepth
        .filter(dbs => {  return configMatch(dbs.source.type, options.depthSourceType) &&
                                 configMatch(dbs.source.talker, options.depthSourceTalker); 
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


    // GPS Position -------------------------------------------------------------------------------------
    this.evtPos = this.getSKBus(options.posPath);

    this.propPos = this.evtPos
        .map(".value")
        .toProperty();

    this.subscribeVal(this.propPos, pos => {
        this.lastPosReceived = this.getTime();
    });

    // this.propPos.onValue(pos => { this.debug(`pos: ${JSON.stringify(pos)}`) } );




    // Engine status ------------------------------------------------------------------------------------
    this.evtEngine = this.getSKBus(options.engineRPMPath);

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

    this.subscribeVal(this.propDepthData.sample(timerInterval * options.recordDataInterval), this.checkData);
    this.subscribeVal(this.propDepthData.sample(timerInterval * options.recordDataInterval), this.recordDepth);
    this.subscribeVal(this.propDepthData.sample(timerInterval * options.recordDataInterval), this.reportTideHeight);


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

  // Done with startup --------------------------------------------------------------------------------
    this.debug('Tide plugin started');
    this.startedOn = this.getTime();

  };

 
  registerWithRouter(router) {

      this.debug("Registering routes...");
      router.get("/api/status", (req, res) => {
          let j = this.getTideStatus();
          this.debug(`Returning JSON call ${JSON.stringify(j)}`)
          res.json(j);
      });

      router.put("/api/location", (req, res) => {
          try {
            this.debug("PUT request!")
            let loc = req.body;
            if (this.captureLocation && this.captureLocation.id == loc.id) {
                this.debug(`Location save for: ${JSON.stringify(loc)}`);
                this.saveLocation(loc);
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
  

  stop() {
    // Here we put logic we need when the plugin stops
    this.running = false;
    this.debug('Tide plugin stopping');
    this.stopRecording();
    this.unsub.forEach(f => f());
    this.unsub = [];
    this.debug('Tide plugin stopped');
    this.setStatus("Stopped");
  };


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
          if (!this.curTideDir) {
             this.setStatus("Watching depth for tide phase...");
          }
          else {
            this.setStatus(`Tracking phase '${this.curTidePhase}'`);
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


  // Returns the current time in milliseconds. Call this
  // whenever time is needed to allow for simulations/unit
  // tests to run.
  getTime() {
    return new Date().getTime();
  }

  slope(x1, y1, x2, y2) {
      return (y2 - y1) / (x2 - x1);
  }


  startRecording(data) {

    this.setStatus("Starting depth recording");
    this.debug(`Data recording started for pos ${JSON.stringify(data.pos)}`);

    this.recordingStartedAt = this.getTime();
    this.recordingData = true;
    this.captureLocation = null;

    this.lowestKnown = {};
    this.highestKnown = {};

    this.lastPhaseReport = null;

    // For "average low tide" calculations...
    this.totalLowTideDepths = 0.0;
    this.totalLowTideSamples = 0;

    this.resetPhaseTracking();

    // Playback any previous data from this location...
    this.setStatus("Playing back data");
    this.liveData = false;
    this.playbackLast30Days(data.pos);

    if (this.lastPhaseReport) {

        let _4DaysAgo = this.getTime() - 4 * 24 * 60 * 60 * 1000;

        if (this.lowestKnown.timer &&
            this.lowestKnown.timer < _4DaysAgo) {
            // The lowest known low tide occurred more than 4 days ago,
            // so just forget we even know it...
            this.lowestKnown = {};
        }

        if (this.highestKnown.timer &&
            this.highestKnown.timer < _4DaysAgo) {
            // The highest known tide is more than 4 days ago, so
            // forget we even know it...
            this.highestKnown = {};
        }

        // If the latest known phase occurred within the last seven hours
        // can just report it. Otherwise, we need to start tracking
        // again...
        let _5HoursAgo = this.getTime() - 7 * 60 * 60 * 1000;
        if (this.lastPhaseReport.timer > _5HoursAgo) {
          this.evtTidePhase.push(this.lastPhaseReport);
        }
        else {
           // We need to start the tracking process over...
           this.resetPhaseTracking();
        }
    }
  }

  
  // Set initial data needed to lock in and track a tide phase
  resetPhaseTracking() {
    this.debug('Resetting tracking status.');
    this.lowestTide = { depth: 99999 };
    this.highestTide = { depth: -1 };
    this.prevData = [];
    this.tideSampleCount = 0;
    this.curTideDir = null;
    this.curTidePhase = "";
    this.depthTrend = 0;
    this.lastKnownTrend = 0;
    this.phaseSwitchCount = 0;
    this.depthTrendCount = [0,0,0];
  }


  getTideStatus() {

      let status = {
        lowestTide: this.lowestTide,
        highestTide:  this.highestTide,
        lowestKnown: this.lowestKnown,
        highestKnown:  this.highestKnown,
        recordingData:  this.recordingData,
        tideSampleCount:  this.tideSampleCount,
        recordingStartedAt:  this.recordingStartedAt,
        captureLocation:  this.captureLocation,
        curTideDir:  this.curTideDir,
        depthTrend: this.depthTrend,
        depthTrendCount: this.depthTrendCount,
        curTidePhase:  this.curTidePhase,
        lastReading: this.lastReading
      };

      if (this.highestKnown && this.highestKnown.timer) {
        status.nextHighestKnown = {};
        status.nextHighestKnown.timer = this.getFuturePhase(this.highestKnown.timer);
        status.nextHighestKnown.depth = this.highestKnown.depth;
      }

      if (this.lowestKnown && this.lowestKnown.timer) {
        status.nextLowestKnown = {};
        status.nextLowestKnown.timer = this.getFuturePhase(this.lowestKnown.timer);
        status.nextLowestKnown.depth = this.lowestKnown.depth;
      }

      return status;
  }


  dump() {
    var stat = this.getTideStatus();
    this.debug(JSON.stringify(stat, null, 1));
  }


  findDepthTrend() {
      var ndx = 0;
      var count = this.depthTrendCount[0];
      if (this.depthTrendCount[2] > count) {
        ndx = 2;
        count = this.depthTrendCount[2];
      }

      if (count >= 4) {
        // Four or more of any one kind (20 minutes) makes the trend. Return
        // +1 for flood, -1 for ebb...
        return ndx - 1;
      }
      else {
        // Can't determine yet...
        return 0;
      }
  }


  // Called every 5 minutes with the current position, and the moving average of
  // last 10 depth checks. Note, may ALSO be called during "data playback"
  // of stored data, in which case this.liveData will be TRUE.
  checkData(data) {
      if (this.liveData) {
          this.debug(`Checking tide data ${JSON.stringify(data)}`);
      }

      this.lastReading = data.timer;

      // Push this most recent sample on to the queue for later use...
      this.prevData.push(data);

      // Once we have collected at least 30 minutes of data, we can do some analysis...
      if (this.prevData.length >= 30 / this.options.recordDataInterval) {

          // Pull data from 30 minutes ago off the front of the FIFO queue...
          var prev = this.prevData.shift();

          this.curTideDir = this.slope(prev.timer, prev.depth, data.timer, data.depth) * 100000.0;
          this.depthTrendCount[Math.sign(this.curTideDir)+1] += 1;

          if (!this.liveData) {
            // this.debug(`   Prev time is: ${new Date(prev.timer)} (${prev.timer})`);         
            this.debug(`   Playback tide data: ${new Date(data.timer)} (${data.timer}) depth ${data.depth.toFixed(3)}  dir: ${this.curTideDir}`);
            // this.debug(`   Depth trend count: ${JSON.stringify(this.depthTrendCount)}`);
          }

          if (this.depthTrend == 0) {
              // No trend has been established as of yet...
              this.depthTrend = this.findDepthTrend();
              if (this.depthTrend != 0) {

                // We have a definitive now!
                this.debug(`Current phase determined as ${this.depthTrend == -1 ? "ebb" : "flood"}`);

                if (this.depthTrend != this.lastKnownTrend) {
                    this.debug('\nNew phase established')
                    this.lastKnownTrend = this.depthTrend;
                    this.phaseSwitchCount++;
  
                    var phase;
                    if (this.depthTrend == -1) {
                        phase = "ebb";
                        this.curTidePhase = phase;
                        // We have gone from flood to ebb, so
                        // we must have found the actual high tide...
                        if (this.phaseSwitchCount > 1) {
                            this.highestKnown.depth = this.highestTide.depth;
                            this.highestKnown.timer = this.highestTide.timer;
                        }
                        this.lowestTide.depth = 99999;
                    }
                    else {
                        phase = "flood";
                        this.curTidePhase = phase;
  
                        // We have gone from ebb to flood, so we
                        // are in search of a new high tide...
                        if (this.phaseSwitchCount > 1) {
                            this.lowestKnown.depth = this.lowestTide.depth;
                            this.lowestKnown.timer = this.lowestTide.timer;
                            this.totalLowTideDepths += this.lowestTide.depth;
                            this.totalLowTideSamples++;
                        }
                        this.highestTide.depth = -1;
                    }
          
                    // Announce we have a new tide phase...
                    this.lastPhaseReport = { timer: data.timer, phase, lowestKnown: this.lowestKnown, highestKnown: this.highestKnown};
                    if (this.liveData) {
                        this.evtTidePhase.push(this.lastPhaseReport);
                    }
                }
              }
          }
          else {
              // We have a trend now.  Is it still good?
              if (Math.sign(this.depthTrend) != Math.sign(this.curTideDir)) {
                  // We are about to flip...
                  this.depthTrend = 0;
                  this.debug('???Suspected phase change');
                  this.depthTrendCount = [0,0,0];
              }
          }
      }


      if (data.depth < this.lowestTide.depth) {
         this.lowestTide.depth = data.depth;
         this.lowestTide.timer = data.timer;
      }

      if (data.depth > this.highestTide.depth) {
         this.highestTide.depth = data.depth;
         this.highestTide.timer = data.timer;
      }

      this.tideSampleCount++;

  }



  getLogFile(pos) {
      let fileName = this.getCaptureName(pos);
      let dbLog = new CircularFile(this.DataLogRecord, 30 * 24 * 12);
      dbLog.open(fileName);
      dbLog.fileName = fileName;
      return dbLog;
  }


  // Called every (1 x options.recordDataInterval) minutes to
  // save the actual data...
  recordDepth(data) {

    try {
        var dbLog = this.getLogFile(data.pos);
        dbLog.appendRecord(data);
        dbLog.close();
        this.debug(`Record data: ${data.timer}\t${data.depth}\t${this.curTideDir}\t${data.pos.latitude}\t${data.pos.longitude}`);
    } catch (err) {
       this.debug(err);
    }
  }


  stopRecording() {
    if (this.recordingData) {
      this.recordingData = false;
      this.recordingStoppedAt = this.getTime();
      this.debug('Data recording ended.');
    }
  }

  getLocations() {
    if (this.locations == null) {
      this.captureIndexFile = this.dataDir + "/locations.json";
      try {
          var raw = fs.readFileSync(this.captureIndexFile, 'utf8');
          this.locations = JSON.parse(raw);
        }
        catch (err) {
          this.debug(`Can read locations file: ${err}`);
          this.debug('Making empty location structure');
          this.locations = [];
        }
    }
  }



  saveLocation(loc) {
     if (this.locations != null) {
        if (loc.id) {
           // update an existing location...
           this.locations[loc.id-1] = loc;
           this.debug(`Saving location: ${JSON.stringify(loc)}`);
        }
        else {
          // Add a new location
          loc.id = this.locations.length + 1;
          this.locations.push(loc);
          this.debug(`Appending new location: ${JSON.stringify(loc)}`);
      }

        fs.writeFileSync(this.captureIndexFile, JSON.stringify(this.locations));
     }
  }



  // Returns the name of a capture file to use for position pos.
  getCaptureName(pos) {

      if (this.captureLocation == null) {
          this.debug('Identifying current location');

          this.getLocations();

          // Check to see if we already have an active file for this location...
          var loc = this.findNearest(pos);

          if (loc == null) {
            this.debug('Adding new location');
            // We need to create a NEW location
            loc = { pos };
            loc.name = "Location " + JSON.stringify(pos);

            // Add it to the index file...
            this.saveLocation(loc);
          }

          this.captureLocation = loc;
      }

      // Now, return the log file name...
      var now = new Date();
      now.setTime(this.getTime());
      return this.dataDir + 
             `/${("0000" + this.captureLocation.id).slice(-5)}.dat`;
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
      this.liveData = false;

      // If there is a gap of more than 40 minutes in the
      // data, reset the phase tracking to lock in to
      // a new phase...
      const trackingTimoutInterval = 40 * 60 * 1000;
      let lastTimer = 0;

      dbLog.forEach(data => {

          if (data.timer >= cutoff) {
              if (data.timer - lastTimer > trackingTimoutInterval) {
                  // A large data gap - reset the phase tracking...
                  this.resetPhaseTracking();
              }
              this.checkData(data);
              lastTimer = data.timer;
          }
          else {
            this.debug(`skipping reccord ${JSON.stringify(data)}`);
          }
      });
      dbLog.close();
      this.liveData = true;
  }


  // Find the location that is nearest to where we are currently
  // at.
  findNearest(pos) {
     let i;
     for (i = 0; i < this.locations.length; i++) {
         let loc = this.locations[i];
         let dist = geolib.getDistance(loc.pos, pos);
         if (dist <= this.options.maxLocationDistance) {
             return loc;
         }
     }
     return null;
  }



  estimateTideHeightNow(now) {

      if (this.recordingData && 
          this.lastPhaseReport && 
          this.totalLowTideSamples > 0 &&
          this.lastPhaseReport.highestKnown.timer &&
          this.lastPhaseReport.lowestKnown.timer) {

          // Compute an average low tide. This is a piss poor estimate for LAT,
          // but it will have to do.  The results are still useful...
          let avgLow = this.totalLowTideDepths / this.totalLowTideSamples;

          // What is our observed change between high and low?
          let lowDepth = this.lastPhaseReport.lowestKnown.depth;
          let highDepth = this.lastPhaseReport.highestKnown.depth;
          let halfWaveHeight =  (highDepth - lowDepth) / 2;
          let midWave = lowDepth + halfWaveHeight;

          var radians;
          if (this.curTidePhase === "ebb") {
              let msElapsed = now - this.lastPhaseReport.highestKnown.timer;
              let pctElapsed = msElapsed / msPhaseLength;
              radians = pctElapsed * Math.PI;
          }
          else if (this.curTidePhase === "flood") {
              let msElapsed = now - this.lastPhaseReport.lowestKnown.timer;
              let pctElapsed = msElapsed / msPhaseLength;
              radians = (pctElapsed * Math.PI) + Math.PI;
          }
          let estHeight = (halfWaveHeight * Math.cos(radians)) + midWave;
          let estTideOffset = estHeight - avgLow;

          return estTideOffset;

      }
      
      // If we get here, we have failed to pass the many requirements needed
      // to make this estimate.
      return null;
  }


  reportTideHeight(data) {

      if (this.recordingData && this.lastPhaseReport) {

        var phaseData = this.lastPhaseReport;

        let values = [
            { path: "environment.tide.phaseNow", value: `${phaseData.phase}`}
        ];

        // See if we have enough data to estimate the tide height...
        let estTideOffset = this.estimateTideHeightNow(data.timer);
        if (estTideOffset != null) {
            values.push(
              { path: "environment.tide.heightNow", value: estTideOffset}
            );
        }


        this.sendSKValues(values);
      }
  }



  /**
   * Adjusts timer to make sure it is in the future, adding
   * enough phase cycles as necessary to get it there.
   */
  getFuturePhase(timer) {
      let nextPhase = timer;
      let now = this.getTime();
      while (nextPhase < now) {
        nextPhase += msPhaseLength;
      } // while
      return nextPhase;
  }


  getFuturePhaseDate(timer) {
     return new Date(this.getFuturePhase(timer));
  }


  // Called whenever a new change in tide phase information is published on the evtTidePhase bus
  onTidePhase(data) {
      // data = { timer: data.timer, phase, lowestKnown: this.lowestKnown, highestKnown: this.highestKnown};

      var values = [
        { path: "environment.tide.phaseNow", value: `${data.phase}`}
      ];


      if (data.lowestKnown.timer) {
          values.push(
              { path: "environment.tide.timeLow", value: this.getFuturePhaseDate(data.lowestKnown.timer).toISOString() }
          );

          values.push(
            { path: "environment.tide.heightLow", value: data.lowestKnown.depth}
          );
      }


      if (data.highestKnown.timer) {
        values.push(
            { path: "environment.tide.timeHigh", value: this.getFuturePhaseDate(data.highestKnown.timer).toISOString() }
        );

        values.push(
          { path: "environment.tide.heightHigh", value: data.highestKnown.depth}
        );
      }

      // See if we have enough data to estimate the tide height...
      let estTideOffset = this.estimateTideHeightNow(data.timer);
      if (estTideOffset != null) {
          values.push(
            { path: "environment.tide.heightNow", value: estTideOffset}
          );
      }

      this.sendSKValues(values);

  }

  // The plugin schema
  schema() { 
    return { type: 'object',
              required: ['some_string', 'some_other_number'],
              properties: {
                depthPath: {
                  type: 'string',
                  title: 'Depth measurement SignalK path',
                  default: 'environment.depth.belowSurface'
                },
                depthSourceType: {
                  type: 'string',
                  title: 'Depth source Type filter',
                  default: ''
                },
                depthSamplesInAverage: {
                  type: 'number',
                  title: 'Number of depth readings in average',
                  description: 'The number of readings in the moving average of depths used for tide phase tracking.',
                  default: 60
                },
                depthSourceTalker: {
                  type: 'string',
                  title: 'Depth source Talker filter',
                  default: ''
                },
                depthDataTimeout: {
                  type: 'number',
                  title: 'Seconds before depth data timeout',
                  default: 30
                },
                posPath: {
                  type: 'string',
                  title: 'GPS position SignalK path',
                  default: 'navigation.position'
                },
                posDataTimeout: {
                  type: 'number',
                  title: 'Seconds before position data timeout',
                  default: 30
              },
                engineRPMPath: {
                  type: 'string',
                  title: 'Engine running SignalK path',
                  default: 'propulsion.1.revolutions'
                },
                recordDataInterval: {
                  type: 'number',
                  title: 'Minutes between depth samples',
                  description: 'The number of minutes between each average depth check when determining tide phase',
                  default: 5
                },
                maxLocationDistance: {
                  type: 'number',
                  title: 'Max location distance',
                  description: 'Max meters between two points for them to be considered in the same location.',
                  default: 100
                }
              }    
            };
  }


  setStatus(msg) {
    this.app.setProviderStatus(msg);
  }

  setError(msg) {
    this.app.setProviderError(msg);
  }

  setDefaultOptions(options) {
    for (var propName in this.schema().properties) {
        this.checkOption(options, propName);
    } // 
  };
  

  checkOption(options, optionName) {
  
      if (typeof options[optionName] === "undefined") {
          options[optionName] = this.schema().properties[optionName].default;
      }
  };


  /**
   * Returns a BaconJS stream that produces the deltas for the specified
   * SignalK path. If allContexts is specified as TRUE, the bus will
   * be for ALL contexts. Otherwise, that data will be restricted to
   * "self" (i.e. data for the boat's "self" context)
   * @param {string} skPath The SK path to receive, or unspecified for ALL data
   * @param {boolean} allContexts TRUE to get ALL vessels data. unspecified or FALSE implies
   *   you want just the data for the current vessel.
   */
  getSKBus(skPath, allContexts) {
     if (allContexts) {
        return this.app.streambundle.getBus(skPath);
     }
     else {
        return this.app.streambundle.getSelfBus(skPath);
     }
  }


  /**
   * Similar to getSKBus() except the data producsed by the BaconJS stream
   * will be limited to the "value" property of the data, vs. the entire delta.
   * @param {string} skPath The SK path to receive, or unspecified for ALL data
   */
  getSKValues(skPath) {
      return this.app.streambundle.getSelfStream(skPath);
  } 


  /**
   * Sends a single value SignalK delta thru the server and out to all external
   * subscribers. To send more than one value at a time, use sendSKValues()
   * @param {string} skPath The SignalK path that corresponds to the value
   * @param {*} value The actual value to send out
   * @see #sendSKValues()
   */
  sendSK(skPath, value) {
    let values = [];

    values.push({ path: skPath, value });

    this.sendSKValues(values);
  }



  /**
   * Sends the specified array of path value objects as a SignalK delta thru the
   * server and out to all external subscribers.
   * @param {array} values An array of one or more objects with each element
   *   being in the format { path: "signal.k.path", value: "someValue" }
   * @see #sendSK()
   */
  sendSKValues(values) {

    var delta = {
      "updates": [
        {
          "source": {
            "label": this.id,
          },
          "values": values
        }
      ]
    };

    this.debug(`sending SignalK: ${JSON.stringify(delta, null, 2)}`);
    this.app.handleMessage(this.id, delta);
  }


  /**
   * Outputs a debug message for this plugin. The message will be visible on the
   * console if DEBUG environment variable is set to this plugin's id.
   * @param {string} msg 
   */
  debug(msg) {
    this.app.debug(msg);
  }

};


module.exports = function (app) {
  var plugin = new TideWatchPlugin(app);
  return plugin;
}