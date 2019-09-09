'use strict';

// Component to display "timer" in locale date/time format
function TimeString(props) {
  if (props.timer) {
    let d = new Date(props.timer);
    let now = new Date().getTime();
    var suffix
    if (d < now) {
      suffix = "ago";
    }
    else {
      suffix = "from now"
    }
    let diff = Math.abs(now - d) / (1000 * 60);
    let hrs = Math.floor(diff / 60);
    let min = Math.floor(diff % 60);
    return `${d.toLocaleString()} (${hrs} hours ${min} minutes ${suffix})`;
  }
  else {
    return null;
  }
}

// Convert depth to display value based on units
function localDepth(depth, units) {
  if (units === "f") {
      return (depth * 3.28084).toFixed(2) + " ft";
  }
  else {
      return depth.toFixed(2) + " m";
  }
}


// Component to output the phase data in the "phase" attribute
function OutputPhase(props) {
   if (props.phase.timer) {
      return (
        <div className="phase">
        <div>{props.header}</div>
        <div>Time: <TimeString timer={props.phase.timer}/></div>
        <div>Depth: {localDepth(props.phase.depth, props.units)}</div>
        </div>
      )
   }
   else {
     return null;
   }
}


// from https://feathericons.com
function IconEdit(props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg"
        onClick={props.onClick}
        width={props.size} 
        height={props.size}
        viewBox={`0 0 ${props.size} ${props.size}`} 
        fill="none" 
        stroke="currentColor" 
        strokeWidth="2" 
        strokeLinecap="round" 
        strokeLinejoin="round" 
        className="feather feather-edit icon">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>
  );
}




class Location extends React.Component {

      constructor(props) {
          super(props);
          this.state = {
            error: null,
            isLoaded: false,
            data: {},
            editing: false,
            editorVal: undefined,
            units: "f"
        };

        this.handleDocKeyDown = this.handleDocKeyDown.bind(this);
        this.handleNameChange = this.handleNameChange.bind(this);
        this.handleUnits = this.handleUnits.bind(this);
      }
    
      updateData() {
        if (this.state.editing) {
          // Ignore
          return;
        }
        fetch("/plugins/signalk-tide-watch/api/status")
          .then((res) => {
             let myres = res;
             return res.json()
          })
          .then(
            (data) => {
              if (typeof this.state.editorVal === 'undefined') {
                 this.setState({ editorVal: data.captureLocation.name} );
              }
              this.setState({
                isLoaded: true,
                error: null,
                data,
              });
            },
            (error) => {
              this.setState({
                isLoaded: true,
                error,
                editing: false
              });
            }
          )
      }

      componentDidMount() {
        document.addEventListener("keydown", this.handleDocKeyDown, false);
        this.updateData();
        this.interval = setInterval(() => this.updateData(), 30000);        
      }
    
      componentWillUnmount() {
        document.removeEventListener("keydown", this.handleDocKeyDown, false);
        clearInterval(this.interval);
      }


      handleNameChange(e) {
        const {name, value} = e.target;
        this.setState(() => ({
          editorVal: value
        }))
      }

      handleDocKeyDown(e) {
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
              })
              .then(response => {
                    return response.json()
              })
              .then(json => { 
                 // Request an update...
                 this.updateData();
              },
              (error) => {
                console.log(JSON.stringify(error));
                this.setState({ error });
              });
           }
           else if (e.key === "Escape") {
              // Undo the editing...
              this.setState({ editing: false, editorVal: this.state.data.captureLocation.name });
           }
        }
      }

      handleUnits(e) {
        this.setState({units: e.target.value});
      }


      render() {
        const { error, isLoaded, data, editing, units } = this.state;

        if (!isLoaded) {
          return <div>Waiting for response from server...</div>;
        }
        else if (error) {
          return <div>Error: {error.message}</div>;
        } 
        else if (!this.state.data.captureLocation) {
          return (
            <div><h1>No current location data</h1></div>
          );
        }
        else {

          let locName;
          if (this.state.editing) {
              locName = <input className="editBox" onChange={this.handleNameChange} value={this.state.editorVal}/>;
          }
          else {
              locName = [
                this.state.data.captureLocation.name,
                <IconEdit size="24" display={editing} onClick={() => { this.setState({editing: !this.state.editing}) } }/>        
              ];
          }
      

          return (
            <div>
              <h1>{locName}</h1>
              <div className="info">Last data reading&nbsp;<TimeString timer={data.lastReading} /></div>
              <div className="info">Recording started on <TimeString timer={data.recordingStartedAt} /></div>
              {  data.recordingStoppedAt 
                 ? <div className="info">Recording stopped at <TimeString timer={data.recordingStoppedAt} /></div>
                 : ""
              }
              <div className="info">Currently recording: {data.recordingData ? 'Yes' : 'No'}</div>
              <div className="info">Total samples in use: {data.tideSampleCount}</div>
              <div className="info">Current tide phase: {data.curTidePhase ? data.curTidePhase : 'Undetermined'}</div>
              <div className="info">
                Units:&nbsp;<select size="1" value={units} onChange={this.handleUnits}>
                  <option value="f">Feet</option>
                  <option value="m">Meters</option>
                </select>
              </div>
              <OutputPhase header="Last low tide" phase={data.lowestKnown} units={units} />
              <OutputPhase header="Next low tide" phase={data.nextLowestKnown}  units={units}/>
              <OutputPhase header="Last high tide" phase={data.highestKnown}  units={units}/>
              <OutputPhase header="Next high tide" phase={data.nextHighestKnown}  units={units}/>
            </div>
          );
        }
      }
}
let domContainer = document.querySelector('#location');
ReactDOM.render(<Location />, domContainer);
