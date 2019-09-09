# SignalK-Tide-Watch
SignalK Tide Watch is a plugin and corresponding Webapp for the [SignalK Node Server](https://github.com/SignalK/signalk-server-node) that allows your boat to be its own tide station. It watches the depth of the water whenever your boat is at rest, and determines the most recent low and high tides, as well as gives an estimate of the next future tides.


## How it works
After installing this plugin on your SignalK server, this Tide Watch plugin will automatically start watching the boat's depth levels at your current location as soon as the boat is determined to be "off."  By default, this determination is made by watching the SignalK path value `propulsion.1.revolutions`. This path can be changed in the plugin's configuration. If this value is zero, missing, or older than 15 seconds, the boat is assumed to be "off". 

When the boat is in the "off" condition, the current GPS position (using the path `navigation.position`) is used
to determine the boat's location.  A log of time, depth, and exact position readings are kept for each unique location. 
It takes about 30 minutes for Tide Watch to determine the general phase of the current tide (ebb or flood).  If Tide Watch
sees a change from ebb to flood time or vice versa, this "last known tide" time is reported.

If the engine is started, recording for that location stops.  If the boat returns to the same location and is stopped
in the future, the log is played back and recording is resumed.  Any values found in the last 4 days or so will be used for future estimates.


## Reviewing the Data
The Tide Watch plugin installs a simple Webapp interface that allows you to review the data it has recorded. You can
view this data in a web browser using the path `/signalk-tide-watch`.  For example:

```
http://my-server.local/signalk-tide-watch
```

The following SignalK data paths are also generated continuously by the Tide Watch plugin:

```
environment.tide.phaseNow

environment.tide.timeLow
environment.tide.heightLow

environment.tide.timeHigh
environment.tide.heightHigh

environment.tide.heightNow
```

## Configuring depth data
By default, Tide Watch takes its depth data from the path `environment.depth.belowSurface` from ANY device that broadcasts
that value.  You can limit the data used for depth watching to a specific device by filling out the value `Depth source Type filter` and/or `Depth source Talker filter` in the plugin configuration.  Any non-blank values for those will limit the readings used to those that have a SignalK data `source` property that exactly matches the corresponding filter.


## Roadmap
- Add ability to use tide information to create a new "subordinate station" entry in the [XTide Json Server](https://github.com/joelkoz/xtwsd) database.

