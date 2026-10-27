import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/app.css';
import './styles/motion.css';
import './styles/landing.css';
import './styles/brand.css';
import { App } from './App';

// Reveals, smooth scroll, the 3D stage and the click hairline only run with motion
// allowed; view transitions only where the browser has them.
const html = document.documentElement;
const motion = matchMedia('(prefers-reduced-motion: no-preference)');
const syncMotion = () => html.classList.toggle('motion-ok', motion.matches);
syncMotion();
motion.addEventListener('change', syncMotion);
if ('startViewTransition' in document) html.classList.add('vt');

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
