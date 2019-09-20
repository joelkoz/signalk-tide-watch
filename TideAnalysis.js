const geolib = require('geolib');

// The next tide phase will occur, on average 12 hours 25 minutes after the last phase...
const msPhaseLength = (12 * 60 + 25) * 60 * 1000;

/**
 * A class for analyzing depth recordings, turning them into workable tide information.
 */
class TideAnalyzer {

    constructor(evtTidePhase, recordDataInterval, maxPosChange, fnDebug) {
        this.evtTidePhase = evtTidePhase;
        this.recordDataInterval = recordDataInterval;
        this.maxPosChange = maxPosChange;
        this.debug = fnDebug;
    }


    start() {
        this.debug("Starting tide analysis");
    
        this.lowestKnown = {};
        this.highestKnown = {};
    
        this.lastPhaseReport = null;
   
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
            status.nextHighestKnown.waveHeight = this.highestKnown.waveHeight;
        }

        if (this.lowestKnown && this.lowestKnown.timer) {
            status.nextLowestKnown = {};
            status.nextLowestKnown.timer = this.getFuturePhase(this.lowestKnown.timer);
            status.nextLowestKnown.depth = this.lowestKnown.depth;
            status.nextLowestKnown.waveHeight = this.lowestKnown.waveHeight;
        }

        status.curTideOffset = this.estimateTideHeightNow(this.getTime());
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
  

    _hoursDiff(timer1, timer2) {
        return Math.abs(timer1 - timer2) / (1000 * 60 * 60);
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

            // Pull data from 30 minutes ago off the front of the FIFO queue so
            // we can compare depths "then and now"...
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

                    // We have a definitive trend now...
                    this.debug(`Current phase determined as ${this.depthTrend == -1 ? "ebb" : "flood"}`);

                    if (this.depthTrend != this.lastKnownTrend) {
                        // Our trend is now different! We have an official phase switch.
                        this.debug('\nNew phase established')
                        this.lastKnownTrend = this.depthTrend;
                        this.phaseSwitchCount++;
    
                        var phase;
                        if (this.depthTrend == -1) {
                            phase = "ebb";
                            this.curTidePhase = phase;
                            if (this.phaseSwitchCount >= 2) {
                                // We have gone from flood to ebb on
                                // our watch.  We know we've seen
                                // the highest depth, so save it...
                                this.highestKnown.depth = this.highestTide.depth;
                                this.highestKnown.timer = this.highestTide.timer;
                                let hrDiff = this._hoursDiff(this.highestKnown.timer, this.lowestKnown.timer);
                                if (hrDiff > 5.5 && hrDiff < 13) {
                                    this.highestKnown.waveHeight = this.highestKnown.depth - this.lowestKnown.depth;
                                }
                            }
                            // We are now in search of a new low tide
                            this.lowestTide.depth = 99999;
                        }
                        else {
                            phase = "flood";
                            this.curTidePhase = phase;
    
                            if (this.phaseSwitchCount >= 2) {
                                // We have gone from ebb to flood on our
                                // watch. We know we've seen the lowest,
                                // so save it...
                                this.lowestKnown.depth = this.lowestTide.depth;
                                this.lowestKnown.timer = this.lowestTide.timer;
                                let hrDiff = this._hoursDiff(this.highestKnown.timer, this.lowestKnown.timer);
                                if (hrDiff > 5.5 && hrDiff < 13) {
                                    this.lowestKnown.waveHeight = this.lowestKnown.depth - this.highestKnown.depth;
                                }
                            }
                            // We are now in search of a new high tide...
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
            this.lowestTide.pos = data.pos;
        }

        if (data.depth > this.highestTide.depth) {
            this.highestTide.depth = data.depth;
            this.highestTide.timer = data.timer;
            this.highestTide.pos = data.pos;
        }

        this.tideSampleCount++;

    }



    estimateTideHeightNow(now) {

        if (this.lastPhaseReport && 
            this.lastPhaseReport.highestKnown.timer &&
            this.lastPhaseReport.lowestKnown.timer) {

            let waveHeight;
            
            var radians;
            if (this.curTidePhase === "ebb") {
                let msElapsed = now - this.lastPhaseReport.highestKnown.timer;
                let pctElapsed = msElapsed / msPhaseLength;
                radians = pctElapsed * Math.PI;
                waveHeight =  Math.abs(this.lastPhaseReport.lowestKnown.waveHeight);
            }
            else if (this.curTidePhase === "flood") {
                let msElapsed = now - this.lastPhaseReport.lowestKnown.timer;
                let pctElapsed = msElapsed / msPhaseLength;
                radians = (pctElapsed * Math.PI) + Math.PI;
                waveHeight =  this.lastPhaseReport.highestKnown.waveHeight;
            }
            let estHeight = (waveHeight * (Math.cos(radians) + 1) / 2);

            return estHeight;
        }
        
        // If we get here, we have failed to pass the many requirements needed
        // to make this estimate.
        return null;
    }

};

module.exports = { TideAnalyzer, msPhaseLength };
