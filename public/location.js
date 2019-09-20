'use strict';

// Component to display "timer" in locale date/time format

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

function TimeString(props) {
  if (props.timer) {
    var d = new Date(props.timer);
    var now = new Date().getTime();
    var suffix;
    if (d < now) {
      suffix = "ago";
    } else {
      suffix = "from now";
    }
    var diff = Math.abs(now - d) / (1000 * 60);
    var hrs = Math.floor(diff / 60);
    var min = Math.floor(diff % 60);
    return d.toLocaleString() + " (" + hrs + " hours " + min + " minutes " + suffix + ")";
  } else {
    return null;
  }
}

// Convert depth to display value based on units
function localDepth(depth, units) {
  if (typeof depth === 'undefined' || depth == null) {
    return '';
  } else if (units === "f") {
    return (depth * 3.28084).toFixed(2) + " ft";
  } else {
    return depth.toFixed(2) + " m";
  }
}

// Component to output the phase data in the "phase" attribute
function OutputPhase(props) {
  if (props.phase && props.phase.timer) {
    return React.createElement(
      "div",
      { className: "phase" },
      React.createElement(
        "div",
        null,
        props.header
      ),
      React.createElement(
        "div",
        null,
        "Time: ",
        React.createElement(TimeString, { timer: props.phase.timer })
      ),
      React.createElement(
        "div",
        null,
        "Wave height: ",
        localDepth(props.phase.waveHeight, props.units)
      ),
      React.createElement(
        "div",
        null,
        "Depth: ",
        localDepth(props.phase.depth, props.units)
      )
    );
  } else {
    return null;
  }
}

// from https://feathericons.com
function IconEdit(props) {
  return React.createElement(
    "svg",
    { xmlns: "http://www.w3.org/2000/svg",
      onClick: props.onClick,
      width: props.size,
      height: props.size,
      viewBox: "0 0 " + props.size + " " + props.size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: "feather feather-edit icon" },
    React.createElement("path", { d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }),
    React.createElement("path", { d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" })
  );
}

var Location = function (_React$Component) {
  _inherits(Location, _React$Component);

  function Location(props) {
    _classCallCheck(this, Location);

    var _this = _possibleConstructorReturn(this, (Location.__proto__ || Object.getPrototypeOf(Location)).call(this, props));

    _this.state = {
      error: null,
      isLoaded: false,
      data: {},
      editing: false,
      editorVal: undefined,
      units: "f"
    };

    _this.handleDocKeyDown = _this.handleDocKeyDown.bind(_this);
    _this.handleNameChange = _this.handleNameChange.bind(_this);
    _this.handleUnits = _this.handleUnits.bind(_this);
    return _this;
  }

  _createClass(Location, [{
    key: "updateData",
    value: function updateData() {
      var _this2 = this;

      if (this.state.editing) {
        // Ignore
        return;
      }
      fetch("/plugins/signalk-tide-watch/api/status").then(function (res) {
        var myres = res;
        return res.json();
      }).then(function (data) {
        if (typeof _this2.state.editorVal === 'undefined') {
          _this2.setState({ editorVal: data.captureLocation.name });
        }
        _this2.setState({
          isLoaded: true,
          error: null,
          data: data
        });
      }, function (error) {
        _this2.setState({
          isLoaded: true,
          error: error,
          editing: false
        });
      });
    }
  }, {
    key: "componentDidMount",
    value: function componentDidMount() {
      var _this3 = this;

      document.addEventListener("keydown", this.handleDocKeyDown, false);
      this.updateData();
      this.interval = setInterval(function () {
        return _this3.updateData();
      }, 30000);
    }
  }, {
    key: "componentWillUnmount",
    value: function componentWillUnmount() {
      document.removeEventListener("keydown", this.handleDocKeyDown, false);
      clearInterval(this.interval);
    }
  }, {
    key: "handleNameChange",
    value: function handleNameChange(e) {
      var _e$target = e.target,
          name = _e$target.name,
          value = _e$target.value;

      this.setState(function () {
        return {
          editorVal: value
        };
      });
    }
  }, {
    key: "handleDocKeyDown",
    value: function handleDocKeyDown(e) {
      var _this4 = this;

      if (this.state.editing) {
        if (e.key === "Enter") {
          // They pressed ENTER - save the edited location name
          this.state.data.captureLocation.name = this.state.editorVal;
          this.setState({ editing: false });

          console.log("Saving location data...");
          fetch("/plugins/signalk-tide-watch/api/location", {
            method: 'PUT',
            body: JSON.stringify(this.state.data.captureLocation),
            headers: {
              "Content-type": "application/json; charset=UTF-8"
            }
          }).then(function (response) {
            return response.json();
          }).then(function (json) {
            // Request an update...
            _this4.updateData();
          }, function (error) {
            console.log(JSON.stringify(error));
            _this4.setState({ error: error });
          });
        } else if (e.key === "Escape") {
          // Undo the editing...
          this.setState({ editing: false, editorVal: this.state.data.captureLocation.name });
        }
      }
    }
  }, {
    key: "handleUnits",
    value: function handleUnits(e) {
      this.setState({ units: e.target.value });
    }
  }, {
    key: "render",
    value: function render() {
      var _this5 = this;

      var _state = this.state,
          error = _state.error,
          isLoaded = _state.isLoaded,
          data = _state.data,
          editing = _state.editing,
          units = _state.units;


      if (!isLoaded) {
        return React.createElement(
          "div",
          null,
          "Waiting for response from server..."
        );
      } else if (error) {
        return React.createElement(
          "div",
          null,
          "Error: ",
          error.message
        );
      } else if (!this.state.data.captureLocation) {
        return React.createElement(
          "div",
          null,
          React.createElement(
            "h1",
            null,
            "No current location data"
          )
        );
      } else {

        var locName = void 0;
        if (this.state.editing) {
          locName = React.createElement("input", { className: "editBox", onChange: this.handleNameChange, value: this.state.editorVal });
        } else {
          locName = [this.state.data.captureLocation.name, React.createElement(IconEdit, { size: "24", display: editing, onClick: function onClick() {
              _this5.setState({ editing: !_this5.state.editing });
            } })];
        }

        return React.createElement(
          "div",
          null,
          React.createElement(
            "h1",
            null,
            locName
          ),
          React.createElement(
            "div",
            { className: "info" },
            "Last data reading\xA0",
            React.createElement(TimeString, { timer: data.lastReading })
          ),
          React.createElement(
            "div",
            { className: "info" },
            "Recording started on ",
            React.createElement(TimeString, { timer: data.recordingStartedAt })
          ),
          data.recordingStoppedAt ? React.createElement(
            "div",
            { className: "info" },
            "Recording stopped at ",
            React.createElement(TimeString, { timer: data.recordingStoppedAt })
          ) : "",
          React.createElement(
            "div",
            { className: "info" },
            "Currently recording: ",
            data.recordingData ? 'Yes' : 'No'
          ),
          React.createElement(
            "div",
            { className: "info" },
            "Total samples in use: ",
            data.tideSampleCount
          ),
          React.createElement(
            "div",
            { className: "info" },
            "Current tide phase: ",
            data.curTidePhase ? data.curTidePhase : 'Undetermined'
          ),
          React.createElement(
            "div",
            { className: "info" },
            "Units:\xA0",
            React.createElement(
              "select",
              { size: "1", value: units, onChange: this.handleUnits },
              React.createElement(
                "option",
                { value: "f" },
                "Feet"
              ),
              React.createElement(
                "option",
                { value: "m" },
                "Meters"
              )
            )
          ),
          React.createElement(
            "div",
            { className: "info" },
            "Current depth offset: ",
            localDepth(data.curTideOffset, units)
          ),
          React.createElement(OutputPhase, { header: "Last low tide", phase: data.lowestKnown, units: units }),
          React.createElement(OutputPhase, { header: "Next low tide", phase: data.nextLowestKnown, units: units }),
          React.createElement(OutputPhase, { header: "Last high tide", phase: data.highestKnown, units: units }),
          React.createElement(OutputPhase, { header: "Next high tide", phase: data.nextHighestKnown, units: units })
        );
      }
    }
  }]);

  return Location;
}(React.Component);

var domContainer = document.querySelector('#location');
ReactDOM.render(React.createElement(Location, null), domContainer);