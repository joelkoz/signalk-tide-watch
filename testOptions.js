const SignalKPlugin = require('./SignalKPlugin.js');
const MockApp = require('./mocks.js').MockApp;


(function() {

    const dataPath = "/Users/Joel/Workspaces/nodejs/signalk/data";

    var app = new MockApp(dataPath)

    class TestPlugin extends SignalKPlugin {

        constructor(app) {
            super(app, 'signalk-test', 'Test plugin', 'Testing SigK plugin');

            this.optStr("optStr", "String option", "some str");
            this.optInt("optIntArray", "Array of numbers", [1,2,3], true);

            this.optObj("objOption", "An object with stuff");
               this.optStr("stringProp", "A string property", "prop val");
               this.optNum("numProp", "A number property", 3.5);
            this.optObjEnd();

            this.optObj("objArray", "An array of objects", true);
               this.optStr("stringProp2", "A string property", "prop val");
               this.optNum("numProp2", "A number property", 3.5);
            this.optObjEnd();
        }
        
    }


    let test = new TestPlugin();

    let schema = test.schema();

    console.log(JSON.stringify(schema, ' ', 3));

})();
