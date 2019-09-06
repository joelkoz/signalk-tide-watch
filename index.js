const Bacon = require('baconjs');
const geolib = require('geolib');
const fs = require('fs');
const CircularFile = require("structured-binary-file").CircularFile;
const Parser = require("binary-parser-encoder").Parser;

module.exports = function (app) {
  var plugin = {};

  plugin.id = 'signalk-tide-watch';
  plugin.name = 'Tide Watch';
  plugin.description = 'Observe tides automatically and predict future tides';
  plugin.app = app;
  plugin.unsub = [];
  plugin.captureLocation = null;
  plugin.locations = null;

  // The next tide phase will occur, on average 12 hours 25 minutes after the last phase...
  const msPhaseLength = (12 * 60 + 25) * 60 * 1000;


  // 'Subscribes' function f to the stream strm, adding its 'unsubscribe' function
  // to the unsub list.
  plugin.subscribeVal = function(strm, f) {
      plugin.unsub.push(strm.onValue(f));
  }


  plugin.start = function (options, restartPlugin) {

    plugin.running = true;

    // Here we put our plugin logic
    app.debug('Tide Watch plugin starting...');
    plugin.showStatus("Starting...");

    plugin.startedOn = -1;
    plugin.setDefaultOptions(options);
    app.debug(`Options: ${JSON.stringify(options)}`);
    plugin.options = options;


    // list of 'unsubscribe' functions we may need to stop the plugin during runtime
    plugin.unsub = [];

    // Returns TRUE if str does not have any contents (ie. is empty, null or undefined)
    function strEmpty(str) {
      return (!str || 0 === str.trim().length);
    }

    // Returns TRUE if the specified configItem matches the specified configVal. An
    // empty configVal is a wildcard that matches any value of configItem
    function configMatch(configItem, configVal) {
        return (strEmpty(configVal) || configItem == configVal);
    }


    plugin.dataDir = app.getDataDirPath();
    app.debug(`Data dir path is ${plugin.dataDir}`);


    // 15 second hearbeat for checking if data has been received.
    var hearbeatInterval = 15000;
    plugin.evtHeartbeat = Bacon.fromPoll(hearbeatInterval, function() { return plugin.getTime() });

    plugin.subscribeVal(plugin.evtHeartbeat, plugin.updateStatus );


    // 1 min event - sends a timer out every one minute ------------------------------------------------
    var timerInterval = 60000;
    // timerInterval = 2000;
    // The main timing loop - every 1 minute
    plugin.evt1min = Bacon.fromPoll(timerInterval, function() { return plugin.getTime() });

    // plugin.subscribeVal(plugin.evt1min, timer => { app.debug(`Timer: ${timer}`) } );




    // Check which SignalK paths are available every 15  seconds, and publish when they change ---------
    // plugin.curPaths =
    // Bacon.fromPoll(15000, function() {
    //           return new Bacon.Next(app.streambundle.getAvailablePaths());
    //       })
    //       .skipDuplicates()
    //       .toProperty([]);
          
    // plugin.subscribeVal(plugin.curPaths, function (paths) {
    //                                   app.debug('Available paths are:');
    //                                   app.debug(paths)
    //                               });      




    // Depth soundings ---------------------------------------------------------------------------------
    plugin.evtDepth = app.streambundle.getSelfBus(options.depthPath);

    plugin.evtDepthVal = plugin.evtDepth
        .filter(dbs => {  return configMatch(dbs.source.type, options.depthSourceType) &&
                                 configMatch(dbs.source.talker, options.depthSourceTalker); 
                        } )
        .map(".value");

    plugin.subscribeVal(plugin.evtDepthVal, depth => {
        plugin.lastDepthReceived = new Date().getTime();
    });
  
    function moving_avg(list) {
      var sum = list.reduce(function(a, b) { return a + b; }, 0);
      var depth = sum / list.length;
      return Math.floor((depth * 1000.0) + 0.5) / 1000.0;
    }

    plugin.avgDepth = plugin.evtDepthVal
          .slidingWindow(plugin.options.depthSamplesInAverage)
          .map(moving_avg)
          .toProperty();

    // plugin.subscribeVal(plugin.avgDepth, depth => { app.debug(`avgDepth: ${depth}`) } );
    // plugin.subscribeVal(plugin.evtDepthVal, depth => { app.debug(`curDepth: ${depth}`) } );
    // plugin.subscribeVal(plugin.evtDepth, depth => { app.debug(`depth: ${JSON.stringify(depth, null, 2)}`) } );


    plugin.evtTidePhase = new Bacon.Bus();
    plugin.subscribeVal(plugin.evtTidePhase, data => { app.debug(`Tide phase: ${JSON.stringify(data)}`) } );
    plugin.subscribeVal(plugin.evtTidePhase, plugin.onTidePhase );


    // GPS Position -------------------------------------------------------------------------------------
    plugin.evtPos = app.streambundle.getSelfBus(options.posPath);

    plugin.curPos = plugin.evtPos
        .map(".value")
        .toProperty();

    plugin.subscribeVal(plugin.curPos, pos => {
        plugin.lastPosReceived = plugin.getTime();
    });

    // plugin.curPos.onValue(pos => { app.debug(`pos: ${JSON.stringify(pos)}`) } );




    // Engine status ------------------------------------------------------------------------------------
    plugin.evtEngine = app.streambundle.getSelfBus(options.engineRPMPath);

    plugin.curRPM = plugin.evtEngine
        .map(".value")
        .toProperty(0);


    plugin.busEngineOn = new Bacon.Bus();
    plugin.engineOn = true; // Set this true only so checkForEngineOff() sends initial "engine off"
    plugin.lastEngineOn = 0;
    plugin.engineSilentInterval = 15 * 1000;

    function checkForEngineOn(rpm) {
        if (rpm > 0) {
          plugin.lastEngineOn = plugin.getTime();
          if (!plugin.engineOn) {
            plugin.engineOn = true;
            plugin.busEngineOn.push(true);
          }
        }
    }
    plugin.subscribeVal(plugin.curRPM, checkForEngineOn);

    function checkForEngineOff(timer) {
        if (plugin.engineOn &&
            (timer - plugin.lastEngineOn) > plugin.engineSilentInterval) {
            plugin.engineOn = false;
            plugin.busEngineOn.push(false);
        }
    }

    plugin.subscribeVal(plugin.evtHeartbeat, checkForEngineOff);

    plugin.subscribeVal(plugin.busEngineOn, status => { app.debug(`Main engine is ${( status ? "ON" : "OFF")}`) } );



    // Reaction: Depth recording at anchor --------------------------------------------------------------------------------

    plugin.evtDataReady = Bacon.combineWith((timer, depth, pos, engineOn) => { 
                                                return { timer, depth, pos } 
                                              }, 
                                              plugin.evt1min, 
                                              plugin.avgDepth, 
                                              plugin.curPos)
                                .sampledBy(plugin.evt1min)
                                .filter(".depth")
                                .filter(data => { return plugin.recordingData; });

    plugin.propDepthData = plugin.evtDataReady.toProperty();

    plugin.subscribeVal(plugin.propDepthData.sample(timerInterval * options.recordDataInterval), plugin.checkData);
    plugin.subscribeVal(plugin.propDepthData.sample(timerInterval * options.recordDataInterval), plugin.recordDepth);
    plugin.subscribeVal(plugin.propDepthData.sample(timerInterval * options.recordDataInterval), plugin.reportTideHeight);


    // A stream that combines the engine status with the current position
    // which controls the start/stop recording events.
    plugin.evtRecordStatus = Bacon.combineWith( (engineOn, pos) => { 
                                                      return { engineOn, pos}; 
                                                },
                                                plugin.busEngineOn,
                                                plugin.curPos)
                                  .sampledBy(plugin.busEngineOn);


    plugin.subscribeVal(plugin.evtRecordStatus, data => {  if (data.engineOn) {
                                                      plugin.stopRecording(data);
                                                  }
                                                  else {
                                                      plugin.startRecording(data);
                                                  }
                                         } );

  // Done with startup --------------------------------------------------------------------------------
    app.debug('Tide plugin started');
    plugin.startedOn = plugin.getTime();

  };

 
  plugin.registerWithRouter = function(router) {

      plugin.app.debug("Registering routes...");
      router.get("/api/status", function(req, res) {
          let j = plugin.getTideStatus();
          plugin.app.debug(`Returning JSON call ${JSON.stringify(j)}`)
          res.json(j);
      });

      router.put("/api/location", function(req, res) {
          try {
            plugin.app.debug("PUT request!")
            let loc = req.body;
            if (plugin.captureLocation && plugin.captureLocation.id == loc.id) {
                plugin.app.debug(`Location save for: ${JSON.stringify(loc)}`);
                plugin.saveLocation(loc);
                plugin.captureLocation = loc;
                res.json({ status: "OK" });
            }
            else {
               throw new Error("Save location does not match current location");
            }
          }
          catch (error) {
            plugin.app.debug(`Error saving location: ${err}`);
            res.status(500).json({ status: "ERROR", error });
          }
      });
  }
  

  plugin.stop = function () {
    // Here we put logic we need when the plugin stops
    plugin.running = false;
    app.debug('Tide plugin stopping');
    plugin.stopRecording();
    plugin.unsub.forEach(f => f());
    plugin.unsub = [];
    app.debug('Tide plugin stopped');
    plugin.showStatus("Stopped");
  };


  plugin.updateStatus = function(timer) {
      if (plugin.startedOn < 0) {
          plugin.showStatus("Starting...");
      }
      else if ((timer - plugin.startedOn) > 30000) {

        if (!plugin.lastDepthReceived ||
              (timer - plugin.lastDepthReceived) > plugin.options.depthDataTimeout * 1000) {
              plugin.showError("No depth data available");
              return;
        }
        else if (!plugin.lastPosReceived ||
          (timer - plugin.lastPosReceived) > plugin.options.posDataTimeout * 1000) {
          plugin.showError("No position data available");
          return;
        }
      }

      if (plugin.recordingData) {
          if (!plugin.curTideDir) {
             plugin.showStatus("Watching depth for tide phase...");
          }
          else {
            plugin.showStatus(`Tracking phase '${plugin.curTidePhase}'`);
          }
      }
      else {
          if (!plugin.running) {
            plugin.showStatus("Stopped");
          }
          else {
            plugin.showStatus("Engine on - not tracking");
          }
      }
     
  }


  // Returns the current time in milliseconds. Call this
  // whenever time is needed to allow for simulations/unit
  // tests to run.
  plugin.getTime = function() {
    return new Date().getTime();
  }

  plugin.slope = function(x1, y1, x2, y2) {
      return (y2 - y1) / (x2 - x1);
  }


  plugin.startRecording = function(data) {

    plugin.showStatus("Starting depth recording");
    plugin.app.debug(`Data recording started for pos ${JSON.stringify(data.pos)}`);

    plugin.recordingStartedAt = plugin.getTime();
    plugin.recordingData = true;
    plugin.captureLocation = null;

    plugin.lowestKnown = {};
    plugin.highestKnown = {};

    plugin.lastPhaseReport = null;

    // For "average low tide" calculations...
    plugin.totalLowTideDepths = 0.0;
    plugin.totalLowTideSamples = 0;

    plugin.resetPhaseTracking();

    // Playback any previous data from this location...
    plugin.showStatus("Playing back data");
    plugin.liveData = false;
    plugin.playbackLast30Days(data.pos);

    if (plugin.lastPhaseReport) {

        let _4DaysAgo = plugin.getTime() - 4 * 24 * 60 * 60 * 1000;

        if (plugin.lowestKnown.timer &&
            plugin.lowestKnown.timer < _4DaysAgo) {
            // The lowest known low tide occurred more than 4 days ago,
            // so just forget we even know it...
            plugin.lowestKnown = {};
        }

        if (plugin.highestKnown.timer &&
            plugin.highestKnown.timer < _4DaysAgo) {
            // The highest known tide is more than 4 days ago, so
            // forget we even know it...
            plugin.highestKnown = {};
        }

        // If the latest known phase occurred within the last five hours
        // can just report it. Otherwise, we need to start tracking
        // again...
        let _5HoursAgo = plugin.getTime() - 5 * 60 * 60 * 1000;
        if (plugin.lastPhaseReport.timer > _5HoursAgo) {
          plugin.evtTidePhase.push(plugin.lastPhaseReport);
        }
        else {
           // We need to start the tracking process over...
           plugin.resetPhaseTracking();
        }
    }
  }

  
  // Set initial data needed to lock in and track a tide phase
  plugin.resetPhaseTracking = function() {
    plugin.app.debug('Resetting tracking status.');
    plugin.lowestTide = { depth: 99999 };
    plugin.highestTide = { depth: -1 };
    plugin.prevData = [];
    plugin.tideSampleCount = 0;
    plugin.curTideDir = null;
    plugin.curTidePhase = "";
    plugin.depthTrend = 0;
    plugin.lastKnownTrend = 0;
    plugin.phaseSwitchCount = 0;
    plugin.depthTrendCount = [0,0,0];
  }


  plugin.getTideStatus = function() {

      status = {
        lowestTide: plugin.lowestTide,
        highestTide:  plugin.highestTide,
        lowestKnown: plugin.lowestKnown,
        highestKnown:  plugin.highestKnown,
        recordingData:  plugin.recordingData,
        tideSampleCount:  plugin.tideSampleCount,
        recordingStartedAt:  plugin.recordingStartedAt,
        captureLocation:  plugin.captureLocation,
        curTideDir:  plugin.curTideDir,
        depthTrend: plugin.depthTrend,
        depthTrendCount: plugin.depthTrendCount,
        curTidePhase:  plugin.curTidePhase,
        lastReading: plugin.lastReading
      };

      if (plugin.highestKnown && plugin.highestKnown.timer) {
        status.nextHighestKnown = {};
        status.nextHighestKnown.timer = plugin.getFuturePhase(plugin.highestKnown.timer);
        status.nextHighestKnown.depth = plugin.highestKnown.depth;
      }

      if (plugin.lowestKnown && plugin.lowestKnown.timer) {
        status.nextLowestKnown = {};
        status.nextLowestKnown.timer = plugin.getFuturePhase(plugin.lowestKnown.timer);
        status.nextLowestKnown.depth = plugin.lowestKnown.depth;
      }

      return status;
  }


  plugin.dump = function () {
     var stat = plugin.getTideStatus();
    plugin.app.debug(JSON.stringify(stat, null, 1));
  }


  plugin.findDepthTrend = function() {
      var ndx = 0;
      var count = plugin.depthTrendCount[0];
      if (plugin.depthTrendCount[2] > count) {
        ndx = 2;
        count = plugin.depthTrendCount[2];
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

  plugin.maxTideSwitchSlope = 0.00015;

  // Called every 5 minutes with the current position, and the moving average of
  // last 10 depth checks. Note, may ALSO be called during "data playback"
  // of stored data, in which case plugin.liveData will be TRUE.
  plugin.checkData = function(data) {
      if (plugin.liveData) {
          plugin.app.debug(`Checking tide data ${JSON.stringify(data)}`);
      }

      plugin.lastReading = data.timer;

      // Push this most recent sample on to the queue for later use...
      plugin.prevData.push(data);

      // Once we have collected at least 30 minutes of data, we can do some analysis...
      if (plugin.prevData.length >= 30 / plugin.options.recordDataInterval) {

          // Pull data from 30 minutes ago off the front of the FIFO queue...
          var prev = plugin.prevData.shift();

          plugin.curTideDir = plugin.slope(prev.timer, prev.depth, data.timer, data.depth) * 100000.0;
          plugin.depthTrendCount[Math.sign(plugin.curTideDir)+1] += 1;

          if (!plugin.liveData) {
            // app.debug(`   Prev time is: ${new Date(prev.timer)} (${prev.timer})`);         
            app.debug(`   Playback tide data: ${new Date(data.timer)} (${data.timer}) depth ${data.depth.toFixed(3)}  dir: ${plugin.curTideDir}`);
            // app.debug(`   Depth trend count: ${JSON.stringify(plugin.depthTrendCount)}`);
          }

          if (plugin.depthTrend == 0) {
              // No trend has been established as of yet...
              plugin.depthTrend = plugin.findDepthTrend();
              if (plugin.depthTrend != 0) {

                // We have a definitive now!
                app.debug(`Current phase determined as ${plugin.depthTrend == -1 ? "ebb" : "flood"}`);

                if (plugin.depthTrend != plugin.lastKnownTrend) {
                    app.debug('\nNew phase established')
                    plugin.lastKnownTrend = plugin.depthTrend;
                    plugin.phaseSwitchCount++;
  
                    var phase;
                    if (plugin.depthTrend == -1) {
                        phase = "ebb";
                        plugin.curTidePhase = phase;
                        // We have gone from flood to ebb, so
                        // we must have found the actual high tide...
                        if (plugin.phaseSwitchCount > 1) {
                            plugin.highestKnown.depth = plugin.highestTide.depth;
                            plugin.highestKnown.timer = plugin.highestTide.timer;
                        }
                        plugin.lowestTide.depth = 99999;
                    }
                    else {
                        phase = "flood";
                        plugin.curTidePhase = phase;
  
                        // We have gone from ebb to flood, so we
                        // are in search of a new high tide...
                        if (plugin.phaseSwitchCount > 1) {
                            plugin.lowestKnown.depth = plugin.lowestTide.depth;
                            plugin.lowestKnown.timer = plugin.lowestTide.timer;
                            plugin.totalLowTideDepths += plugin.lowestTide.depth;
                            plugin.totalLowTideSamples++;
                        }
                        plugin.highestTide.depth = -1;
                    }
          
                    // Announce we have a new tide phase...
                    plugin.lastPhaseReport = { timer: data.timer, phase, lowestKnown: plugin.lowestKnown, highestKnown: plugin.highestKnown};
                    if (plugin.liveData) {
                        plugin.evtTidePhase.push(plugin.lastPhaseReport);
                    }
                }
              }
          }
          else {
              // We have a trend now.  Is it still good?
              if (Math.sign(plugin.depthTrend) != Math.sign(plugin.curTideDir)) {
                  // We are about to flip...
                  plugin.depthTrend = 0;
                  app.debug('???Suspected phase change');
                  plugin.depthTrendCount = [0,0,0];
              }
          }
      }


      if (data.depth < plugin.lowestTide.depth) {
         plugin.lowestTide.depth = data.depth;
         plugin.lowestTide.timer = data.timer;
      }

      if (data.depth > plugin.highestTide.depth) {
         plugin.highestTide.depth = data.depth;
         plugin.highestTide.timer = data.timer;
      }

      plugin.tideSampleCount++;

  }


  plugin.DataLogRecord = Parser.start()
                               .double("timer")
                               .float("depth")
                               .nest("pos", { type: Parser.start()
                                                       .double("latitude")
                                                       .double("longitude")
                                               });

  plugin.getLogFile = function(pos) {
      let fileName = plugin.getCaptureName(pos);
      let dbLog = new CircularFile(plugin.DataLogRecord, 30 * 24 * 12);
      dbLog.open(fileName);
      dbLog.fileName = fileName;
      return dbLog;
  }


  // Called every (1 x options.recordDataInterval) minutes to
  // save the actual data...
  plugin.recordDepth = function(data) {

    try {
        var dbLog = plugin.getLogFile(data.pos);
        dbLog.appendRecord(data);
        dbLog.close();
        plugin.app.debug(`Record data: ${data.timer}\t${data.depth}\t${plugin.curTideDir}\t${data.pos.latitude}\t${data.pos.longitude}`);
    } catch (err) {
       plugin.app.debug(err);
    }
  }


  plugin.stopRecording = function() {
    if (plugin.recordingData) {
      plugin.recordingData = false;
      plugin.recordingStoppedAt = plugin.getTime();
      plugin.app.debug('Data recording ended.');
    }
  }

  plugin.getLocations = function() {
    if (plugin.locations == null) {
      plugin.captureIndexFile = plugin.dataDir + "/locations.json";
      try {
          var raw = fs.readFileSync(plugin.captureIndexFile, 'utf8');
          plugin.locations = JSON.parse(raw);
        }
        catch (err) {
          plugin.app.debug(`Can read locations file: ${err}`);
          plugin.app.debug('Making empty location structure');
          plugin.locations = [];
        }
    }
  }



  plugin.saveLocation = function(loc) {
     if (plugin.locations != null) {
        if (loc.id) {
           // update an existing location...
           plugin.locations[loc.id-1] = loc;
           plugin.app.debug(`Saving location: ${JSON.stringify(loc)}`);
        }
        else {
          // Add a new location
          loc.id = plugin.locations.length + 1;
          plugin.locations.push(loc);
          plugin.app.debug(`Appending new location: ${JSON.stringify(loc)}`);
      }

        fs.writeFileSync(plugin.captureIndexFile, JSON.stringify(plugin.locations));
     }
  }



  // Returns the name of a capture file to use for position pos.
  plugin.getCaptureName = function(pos) {

      if (plugin.captureLocation == null) {
          plugin.app.debug('Identifying current location');

          plugin.getLocations();

          // Check to see if we already have an active file for this location...
          var loc = plugin.findNearest(pos);

          if (loc == null) {
            plugin.app.debug('Adding new location');
            // We need to create a NEW location
            loc = { pos };
            loc.name = "Location " + JSON.stringify(pos);

            // Add it to the index file...
            plugin.saveLocation(loc);
          }

          plugin.captureLocation = loc;
      }

      // Now, return the log file name...
      var now = new Date();
      now.setTime(plugin.getTime());
      return plugin.dataDir + 
             `/${("0000" + plugin.captureLocation.id).slice(-5)}.dat`;
  }



  // Play back the last 31 days (or so) of depth
  // information to see if there is any
  // useful interformation. This also prevents
  // a system restart from losing important
  // tracking data.
  plugin.playbackLast30Days = function(pos) {

      let dbLog = plugin.getLogFile(pos);

      // Ignore entries more than 31 days ago...
      var cutoff = plugin.getTime();
      cutoff -= 31 * 24 * 60 * 60 * 1000;

      plugin.app.debug(`Playing back contents of ${dbLog.fileName}`);
      plugin.liveData = false;

      // If there is a gap of more than 40 minutes in the
      // data, reset the phase tracking to lock in to
      // a new phase...
      const trackingTimoutInterval = 40 * 60 * 1000;
      let lastTimer = 0;

      dbLog.forEach(data => {

          if (data.timer >= cutoff) {
              if (data.timer - lastTimer > trackingTimoutInterval) {
                  // A large data gap - reset the phase tracking...
                  plugin.resetPhaseTracking();
              }
              plugin.checkData(data);
              lastTimer = data.timer;
          }
          else {
            app.debug(`skipping reccord ${JSON.stringify(data)}`);
          }
      });
      dbLog.close();
      plugin.liveData = true;
  }


  // Find the location that is nearest to where we are currently
  // at.
  plugin.findNearest = function(pos) {
     let i;
     for (i = 0; i < plugin.locations.length; i++) {
         let loc = plugin.locations[i];
         let dist = geolib.getDistance(loc.pos, pos);
         if (dist <= plugin.options.maxLocationDistance) {
             return loc;
         }
     }
     return null;
  }



  plugin.estimateTideHeightNow = function(now) {

      if (plugin.recordingData && 
          plugin.lastPhaseReport && 
          plugin.totalLowTideSamples > 0 &&
          plugin.lastPhaseReport.highestKnown.timer &&
          plugin.lastPhaseReport.lowestKnown.timer) {

          // Compute an average low tide. This is a piss poor estimate for LAT,
          // but it will have to do.  The results are still useful...
          let avgLow = plugin.totalLowTideDepths / plugin.totalLowTideSamples;

          // What is our observed change between high and low?
          let lowDepth = plugin.lastPhaseReport.lowestKnown.depth;
          let highDepth = plugin.lastPhaseReport.highestKnown.depth;
          let halfWaveHeight =  (highDepth - lowDepth) / 2;
          let midWave = lowDepth + halfWaveHeight;

          var radians;
          if (plugin.curTidePhase === "ebb") {
              let msElapsed = now - plugin.lastPhaseReport.highestKnown.timer;
              let pctElapsed = msElapsed / msPhaseLength;
              radians = pctElapsed * Math.PI;
          }
          else if (plugin.curTidePhase === "flood") {
              let msElapsed = now - plugin.lastPhaseReport.lowestKnown.timer;
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


  plugin.reportTideHeight = function(data) {

      if (plugin.recordingData && plugin.lastPhaseReport) {

        var phaseData = plugin.lastPhaseReport;

        values = [
            { path: "environment.tide.phaseNow", value: `${phaseData.phase}`}
        ];

        // See if we have enough data to estimate the tide height...
        let estTideOffset = plugin.estimateTideHeightNow(data.timer);
        if (estTideOffset != null) {
            values.push(
              { path: "environment.tide.heightNow", value: estTideOffset}
            );
        }


        plugin.sendSignalK(values);
      }
  }



  /**
   * Adjusts timer to make sure it is in the future, adding
   * enough phase cycles as necessary to get it there.
   */
  plugin.getFuturePhase = function(timer) {
      let nextPhase = timer;
      let now = plugin.getTime();
      while (nextPhase < now) {
        nextPhase += msPhaseLength;
      } // while
      return nextPhase;
  }


  plugin.getFuturePhaseDate = function(timer) {
     return new Date(plugin.getFuturePhase(timer));
  }


  // Called whenever a new change in tide phase information is published on the evtTidePhase bus
  plugin.onTidePhase = function (data) {
      // data = { timer: data.timer, phase, lowestKnown: plugin.lowestKnown, highestKnown: plugin.highestKnown};

      var values = [
        { path: "environment.tide.phaseNow", value: `${data.phase}`}
      ];


      if (data.lowestKnown.timer) {
          values.push(
              { path: "environment.tide.timeLow", value: plugin.getFuturePhaseDate(data.lowestKnown.timer).toISOString() }
          );

          values.push(
            { path: "environment.tide.heightLow", value: data.lowestKnown.depth}
          );
      }


      if (data.highestKnown.timer) {
        values.push(
            { path: "environment.tide.timeHigh", value: plugin.getFuturePhaseDate(data.highestKnown.timer).toISOString() }
        );

        values.push(
          { path: "environment.tide.heightHigh", value: data.highestKnown.depth}
        );
      }

      // See if we have enough data to estimate the tide height...
      let estTideOffset = plugin.estimateTideHeightNow(data.timer);
      if (estTideOffset != null) {
          values.push(
            { path: "environment.tide.heightNow", value: estTideOffset}
          );
      }

      plugin.sendSignalK(values);

  }

  plugin.sendSignalK = function(values) {

    var delta = {
      "updates": [
        {
          "source": {
            "label": plugin.id,
          },
          "values": values
        }
      ]
    };

    plugin.app.debug(`sending SignalK: ${JSON.stringify(delta, null, 2)}`);
    plugin.app.handleMessage(plugin.id, delta);
  }

  // The plugin schema
  plugin.schema = {
    type: 'object',
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


  plugin.showStatus = function(msg) {
    plugin.app.setProviderStatus(msg);
  }

  plugin.showError = function(msg) {
    plugin.app.setProviderError(msg);
  }

  plugin.setDefaultOptions = function(options) {
    for (var propName in plugin.schema.properties) {
        plugin.checkOption(options, propName);
    } // 
  };
  

  plugin.checkOption = function(options, optionName) {
  
      if (typeof options[optionName] === "undefined") {
          options[optionName] = plugin.schema.properties[optionName].default;
      }
  };

  return plugin;
};

