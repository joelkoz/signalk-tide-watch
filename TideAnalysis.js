// The next tide phase will occur, on average 12 hours 25 minutes after the last phase...
const msPhaseLength = (12 * 60 + 25) * 60 * 1000;

/**
 * A class for analyzing depth recordings, turning them into workable tide information.
 */
class TideAnalyzer {

    constructor(evtTidePhase, recordDataInterval, fnDebug) {
        this.evtTidePhase = evtTidePhase;
        this.recordDataInterval = recordDataInterval;
        this.debug = fnDebug;
    }


    start() {
        this.debug("Starting tide analysis");
    
        this.lowestKnown = {};
        this.highestKnown = {};
    
        this.lastPhaseReport = null;
    
        // For "average low tide" calculations...
        this.totalLowTideDepths = 0.0;
        this.totalLowTideSamples = 0;
    
        this.resetPhaseTracking();
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


    /**
     * Returns the tide tracking data as an object
     */
    getTideStatus() {
        let status = {
            lowestTide: this.lowestTide,
            highestTide:  this.highestTide,
            lowestKnown: this.lowestKnown,
            highestKnown:  this.highestKnown,
            tideSampleCount:  this.tideSampleCount,
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


    getTime() {
        return new Date().getTime();
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


    slope(x1, y1, x2, y2) {
        return (y2 - y1) / (x2 - x1);
    }
  

    /**
     * Called every time a new data point is to be added to the analysis.
     * @param {object} data Data object that must include {timer, depth }
     * @param {boolean} liveData TRUE if live data is being analyzed. FALSE if
     *    it is being played back
     */
    includeData(data, liveData) {
        if (liveData) {
            this.debug(`Checking tide data ${JSON.stringify(data)}`);
        }

        this.lastReading = data.timer;

        // Push this most recent sample on to the queue for later use...
        this.prevData.push(data);

        // Once we have collected at least 30 minutes of data, we can do some analysis...
        if (this.prevData.length >= 30 / this.recordDataInterval) {

            // Pull data from 30 minutes ago off the front of the FIFO queue...
            var prev = this.prevData.shift();

            this.curTideDir = this.slope(prev.timer, prev.depth, data.timer, data.depth) * 100000.0;
            this.depthTrendCount[Math.sign(this.curTideDir)+1] += 1;

            if (!liveData) {
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
                        if (liveData) {
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



    estimateTideHeightNow(now) {

        if (this.lastPhaseReport && 
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

};

module.exports = { TideAnalyzer, msPhaseLength };
