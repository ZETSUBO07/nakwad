import "./styles.css";
import "./ui/app.css";
import { startApp } from "./ui/app";

const root = document.getElementById("app");
if (root) void startApp(root);
