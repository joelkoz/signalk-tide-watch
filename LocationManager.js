const fs = require('fs');
const geolib = require('geolib');

/**
 * A class that manages the individual locations where depth data can be recorded
 */
class LocationManager {
    constructor(dataDir, maxLocationDistance, fnDebug) {
        this.maxLocationDistance = maxLocationDistance;
        this.dataDir = dataDir;
        this.debug = fnDebug;
        this.locations = null;
    }


    /**
     * Returns the nearest location to the specified position object. If no location
     * exists, one is created.
     * @param {object} pos 
     */
    getNearest(pos) {
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

        return loc;
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
    
        
      /**
       * Saves the specified location object back to the location database.
       * @param {object} loc 
       */
      saveLocation(loc) {
         this.getLocations();
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
    

      // Find the location that is nearest to where we are currently
      // at.
      findNearest(pos) {
          let i;
          for (i = 0; i < this.locations.length; i++) {
              let loc = this.locations[i];
              let dist = geolib.getDistance(loc.pos, pos);
              if (dist <= this.maxLocationDistance) {
                  return loc;
              }
          }
          return null;
      }

};


module.exports = LocationManager;