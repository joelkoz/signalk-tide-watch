const Plugin = require('./index.js');
const MockApp = require('./mocks.js').MockApp;


(function() {

    const dataPath = "/Users/Joel/Workspaces/nodejs/signalk/data";

    var app = new MockApp(dataPath)

    var plugin = Plugin(app);
    var options = {};
    plugin.start(options);

    var data = { pos: { lat: 26.285139, lng: -80.090347 } };

    plugin.startRecording(data);

    plugin.stopRecording();

    var status = plugin.tideInfo.getTideStatus();

    plugin.stop();

    console.log(JSON.stringify(status, null, 3));

})();
