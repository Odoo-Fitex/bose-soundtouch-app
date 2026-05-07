import "./components/st-app.js";
import { bootstrap } from "./store.js";

bootstrap().catch((e) => console.error("bootstrap failed", e));
