const CircularFile = require("structured-binary-file").CircularFile;
const Parser = require("binary-parser-encoder").Parser;

class DBDepthLog extends CircularFile {

    // Depth log consists of the last 30 days worth of data (assuming data reads every 5 minutes)
    constructor(recordDataInterval) {
        super(Parser.start()
                    .double("timer")
                    .float("depth")
                    .nest("pos", { type: Parser.start()
                                                .double("latitude")
                                                .double("longitude")
                        }),
                        30 * 24 * (60 / recordDataInterval));
    }
};



module.exports = DBDepthLog;
