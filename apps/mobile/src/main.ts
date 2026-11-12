import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { recentTargets } from '$lib/targets.svelte';

const app = mount(App, { target: document.getElementById('app')! });
void recentTargets.init();
export default app;
