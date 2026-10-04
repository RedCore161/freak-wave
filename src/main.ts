import './style.css';
import { Game } from './game/Game.ts';
import { SceneView } from './render/SceneView.ts';
import { Ui } from './ui/Ui.ts';

const app = document.getElementById('app')!;
const viewEl = document.getElementById('view')!;
const view = new SceneView(viewEl);
const ui = new Ui(app);
const game = new Game(view, ui);
// Exposed in dev builds for the Playwright playtest script.
if (import.meta.env.DEV) Object.assign(window, { __freakwave: { game, view } });
