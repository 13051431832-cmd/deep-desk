import { render } from "preact";
import { App } from "./App";
import "./styles/index.css";

import * as store from "./store";
(window as any).__store = store;

render(<App />, document.getElementById("app")!);
