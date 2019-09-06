const Bacon = require('baconjs');
const fs = require('fs');
const readline = require('readline');
const Plugin = require('./index.js');


class MockStreambundle {

    constructor() {
        this._selfBus = {}
    }

    getSelfBus(path) {
        var bus = this._selfBus[path];
        if (!bus) {
            bus = new Bacon.Bus();
            this._selfBus[path] = bus;
        }
        return bus;
    }


    pushMockValue(path, value) {
        var bus = this.getSelfBus(path);
        bus.push(value);
    }

}




class MockApp {

    constructor(dataDir) {
        this._dataDir = dataDir;
        this.streambundle = new MockStreambundle();
    }

    debug(output) {
        console.log(output);
    }

    getDataDirPath() {
        return this._dataDir;
    }

    handleMessage(id, delta) {
        console.log(`\nSignalK from ${id}:\n${JSON.stringify(delta, null, 2)}\n`)
    }

    setProviderStatus(msg) {
        console.log(`Plugin status: ${msg}`);
    }
}


(function() {

    const dataPath = "/Users/Joel/Workspaces/nodejs/signalk/data";

    var app = new MockApp(dataPath)

    var plugin = Plugin(app);
    var options = {};
    plugin.start(options);

    var data = { pos: { lat: 26.285139, lng: -80.090347 } };

    plugin.startRecording(data);

    plugin.stopRecording();

    plugin.stop();

    var status = plugin.getTideStatus();

    console.log(JSON.stringify(status, null, 3));

})();
