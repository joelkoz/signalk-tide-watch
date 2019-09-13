

/**
 * Base class for creating a SignalK Node Server plugin. This class provides
 * basic behaviors desireable to all plugins.
 */
class SignalKPlugin {

    constructor(app, id, name, description) {
        this.app = app;
        this.id = id;
        this.name = name;
        this.description = description;
        this._schema = { type: "object", properties: {} };
        this._optContainers = [ this._schema.properties ];
    }


    /** 
     * Returns the current time in milliseconds. Call this
     * whenever the current time is needed. External unit tests
     * may monkey patch this method to return a simulated time of
     * day while the tests are running.
     */
    getTime() {
      return new Date().getTime();
    }


    /**
     * Called when the plugin starts. Descendant classes should override, but
     * call super.start().
     */
    start(options, restartPlugin) {
        this.startedOn = -1;

        this.unsub = [];

        this.running = true;
        this.restartPlugin = restartPlugin;
    
        // Here we put our plugin logic
        this.debug(`${this.name} plugin starting...`);
        this.setStatus("Starting...");
    
        this._setDefaultOptions(options);
        this.debug(`Options: ${JSON.stringify(options)}`);
        this.options = options;

        this.dataDir = this.app.getDataDirPath();
        this.debug(`Data dir path is ${this.dataDir}`);
    
        this.onPluginStarted();

        this.debug(`${this.name} started`);
        this.startedOn = this.getTime();
    }


    /**
     * Called once the plugin has started and all options have been resolved.  Normally, this
     * creates the BaconJS data streams and properties used by this plugin and subscribes
     * to them.
     */
    onPluginStarted() {
        this.debug('WARNING: No data streams defined. onPluginStarted() should be overridden.');
    }    


    /**
     * Called when the plugin stops.  Cleanup occurs here, including
     * unsubscribing from any data paths.
     */
    stop() {
        this.running = false;
        this.debug(`${this.name} stopping`);
        this.unsub.forEach(f => f());
        this.unsub = [];

        this.onPluginStopped();

        this.setStatus("Stopped");
        this.debug(`${this.name} stopped`);
        this.startedOn = -1;
    };



   /**
    * Called when the plugin is to stop running.
    */
    onPluginStopped() {
    }


    /**
     * Sets the status of this plugin, placing msg on the server admin app.
     * @param {string} msg 
     */
    setStatus(msg) {
        this.app.setProviderStatus(msg);
    }
    

   /**
     * Used to indicate an error has occurred in the pluging. The specified msg
     * will appear on the server admin app
     * @param {string} msg 
     */
    setError(msg) {
        this.app.setProviderError(msg);
    }

    
    
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
     * 'Subscribes' function f to the stream strm, adding its 'unsubscribe' function
     * to the unsub list.
     * @param {Bacon.Stream} strm 
     * @param {function} f Any function or method from this object 
     */
    subscribeVal(strm, f) {
        this.unsub.push(strm.onValue(f.bind(this)));
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


    /**
     * Returns a schema that lists the user configurable options that this plugin utilizes
     */
    schema() {
        return this._schema;
    }
    
    

    /**
     * Defines a string configuration option that the user can set. The specified optionName
     * will appear as a property in this.options, and will have a default value of defaultVal.
     * @param {string} optionName The name of the property variable used for this option
     * @param {string} title A label that describes this option (short form)
     * @param {string} defaultVal The default value to use for this option
     * @param {boolean} isArray TRUE if this option is actually an array of strings
     * @param {string} longDescription An optional long description of this option
     */
    optStr(optionName, title, defaultVal, isArray, longDescription) {
        this._defineOption('string', optionName, title, defaultVal, isArray, longDescription);
    }


    /**
     * Defines a numeric configuration option that the user can set. The specified optionName
     * will appear as a property in this.options, and will have a default value of defaultVal.
     * @param {string} optionName The name of the property variable used for this option
     * @param {string} title A label that describes this option (short form)
     * @param {number} defaultVal The default value to use for this option
     * @param {boolean} isArray TRUE if this option is actually an array of numbers
     * @param {string} longDescription An optional long description of this option
     */
    optNum(optionName, title, defaultVal, isArray, longDescription) {
        this._defineOption('number', optionName, title, defaultVal, isArray, longDescription);
    }


    /**
     * Defines an interger configuration option that the user can set. The specified optionName
     * will appear as a property in this.options, and will have a default value of defaultVal.
     * @param {string} optionName The name of the property variable used for this option
     * @param {string} title A label that describes this option (short form)
     * @param {integer} defaultVal The default value to use for this option
     * @param {boolean} isArray TRUE if this option is actually an array of integers
     * @param {string} longDescription An optional long description of this option
     */
    optInt(optionName, title, defaultVal, isArray, longDescription) {
        this._defineOption('integer', optionName, title, defaultVal, isArray, longDescription);
    }


    /**
     * Defines a boolean configuration option that the user can set. The specified optionName
     * will appear as a property in this.options, and will have a default value of defaultVal.
     * @param {string} optionName The name of the property variable used for this option
     * @param {string} title A label that describes this option (short form)
     * @param {boolean} defaultVal The default value to use for this option
     * @param {boolean} isArray TRUE if this option is actually an array of booleans
     * @param {string} longDescription An optional long description of this option
     */
    optBool(optionName, title, defaultVal, isArray, longDescription) {
        this._defineOption('boolean', optionName, title, defaultVal, isArray, longDescription);
    }


    // General purpose worker method to set options. Used by the other
    // optXXX() methods.
    _defineOption(optionType, optionName, title, defaultVal, isArray, longDescription) {
        let opt = {
            title,
            default: defaultVal,
            description: longDescription
        };

        if (isArray) {
           opt.type = 'array';
           opt.items = { type: optionType };
        }
        else {
           opt.type = optionType;
        }

        let container = this._optContainers[this._optContainers.length-1];
        container[optionName] = opt;
    }



    /**
     * Defines configuration option that is itself an object of other properties that the user can set. 
     * The specified optionName will appear as a property in this.options. Once this method is called,
     * all other calls to the optXXX() definition methods will place those properties in this
     * object. This will continue until optObjEnd() is called.  You MUST call optObjEnd() when
     * the object definition has been completed.
     * @see optObjEnd()
     * @param {string} optionName The name of the property variable used for this option
     * @param {string} title A label that describes this option (short form)
     * @param {boolean} defaultVal The default value to use for this option
     * @param {boolean} isArray TRUE if this option is actually an array of the defined object
     * @param {string} longDescription An optional long description of this option
     */
    optObj(optionName, title, isArray, longDescription) {

        let container = this._optContainers[this._optContainers.length-1];

        let opt = {
            title,
            description: longDescription
        };

        if (isArray) {
            opt.type = 'array';
            opt.items = { type: 'object', properties: {} };
            this._optContainers.push(opt.items.properties);
         }
        else {
           opt.type = 'object';
           opt.properties = {};
           this._optContainers.push(opt.properties);
        }
        container[optionName] = opt;
    }


    /**
     * Call this method to end the definition of an object property.
     */
    optObjEnd() {
        this._optContainers.pop();
    }



    // Internal method used to ensure each option in the options list has
    // a value that matches the data returned by schema(). If no value exists,
    // it is added, using the default value specified in the schema.
    _setDefaultOptions(options) {
        for (var propName in this.schema().properties) {
            this._checkOption(options, propName);
        } // 
    };

    
    // Check an individual option, creating it with the default value if it
    // does not exist.
    _checkOption(options, optionName) {
        if (typeof options[optionName] === "undefined") {
            options[optionName] = this.schema().properties[optionName].default;
        }
    };


    /**
     * Returns TRUE if the specified test value matches the specified matchVal. An
     * empty matchVal is a wildcard that matches any value of testVal. This method
     * is useful for matching optional configuration values to stream filters.
     */
    wildcardEq(testVal, matchVal) {

        function strEmpty(str) {
            return (!str || 0 === str.trim().length);
          }
  
          return (strEmpty(matchVal) || testVal == matchVal);
    }


}

module.exports = SignalKPlugin;