

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
    }


    /**
     * Called when the plugin starts. Descendant classes should override, but
     * call super.start().
     */
    start(options, restartPlugin) {

        this.unsub = [];

        this.running = true;
        this.restartPlugin = restartPlugin;
    
        // Here we put our plugin logic
        this.debug(`${this.name} plugin starting...`);
        this.setStatus("Starting...");
    
        this.setDefaultOptions(options);
        this.debug(`Options: ${JSON.stringify(options)}`);
        this.options = options;
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
        this.setStatus("Stopped");
    };


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
     * 'Subscribes' function f to the stream strm, adding its 'unsubscribe' function
     * to the unsub list.
     * @param {Bacon.Stream} strm 
     * @param {function} f Any function or method from this object 
     */
    subscribeVal(strm, f) {
        this.unsub.push(strm.onValue(f.bind(this)));
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


    schema() {
        return _schema;
    }
    

    // Internal method used to ensure each option in the options list has
    // a value that matches the data returned by schema(). If no value exists,
    // it is added, using the default value specified in the schema.
    setDefaultOptions(options) {
        for (var propName in this.schema().properties) {
            this.checkOption(options, propName);
        } // 
    };

    
    // Check an individual option, creating it with the default value if it
    // does not exist.
    checkOption(options, optionName) {
        if (typeof options[optionName] === "undefined") {
            options[optionName] = this.schema().properties[optionName].default;
        }
    };
}

module.exports = SignalKPlugin;