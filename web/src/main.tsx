import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/app.css';
import './styles/motion.css';
import './styles/landing.css';
import { App } from './App';
import { DUR, EASE_TOGGLE } from './motion/tokens';

// Reveals, smooth scroll, the 3D stage and the click hairline only run with motion
// allowed; view transitions only where the browser has them.
const html = document.documentElement;
const motion = matchMedia('(prefers-reduced-motion: no-preference)');
const syncMotion = () => html.classList.toggle('motion-ok', motion.matches);
syncMotion();
motion.addEventListener('change', syncMotion);
if ('startViewTransition' in document) html.classList.add('vt');

// The click hairline: a press on any enabled .btn draws the rule under its label and
// lets it go (app.css draws .btn::after). One listener for every button, present and future.
// An engine without pseudo-element animations would scale the button itself, so it gets none.
if (typeof KeyframeEffect === 'function' && 'pseudoElement' in KeyframeEffect.prototype) {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !html.classList.contains('motion-ok')) return;
      try {
        const btn = e.target instanceof Element ? e.target.closest('.btn') : null;
        if (!btn || btn.matches(':disabled, [aria-disabled="true"]')) return;
        btn.animate(
          [
            { transform: 'scaleX(0)', opacity: 1 },
            { transform: 'scaleX(1)', opacity: 1, offset: 0.6 },
            { transform: 'scaleX(1)', opacity: 0 },
          ],
          { duration: DUR.roll, easing: EASE_TOGGLE, pseudoElement: '::after' },
        );
      } catch {
        // Decoration only: the press itself is CSS.
      }
    },
    { passive: true },
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
