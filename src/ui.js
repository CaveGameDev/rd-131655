/* New file: ui.js — ESC modal and button wiring extracted from previous inline IIFE in main.js */
(function() {
  try {
    const modal = document.getElementById('escModal');
    if (!modal) return;

    const modalPosition = {
      left: '50%',
      top: 'calc(50% + 40px)',
      transform: 'translate(-50%, -50%)'
    };

    function applyModalPosition() {
      try {
        modal.style.left = modalPosition.left;
        modal.style.top = modalPosition.top;
        modal.style.transform = modalPosition.transform;
      } catch (e) {}
    }

    function showModal(show) {
      applyModalPosition();
      modal.style.display = show ? 'flex' : 'none';
      modal.setAttribute('aria-hidden', show ? 'false' : 'true');

      try {
        const bd = document.getElementById('escBackdrop');
        if (bd) {
          bd.classList.toggle('active', !!show);
          bd.style.display = show ? 'block' : 'none';
          bd.style.left = '50%';
          bd.style.top = '50%';
          bd.style.transform = 'translate(-50%, -50%)';
        }
      } catch (e) { console.warn('escBackdrop toggle failed', e); }
    }

    function pauseGame() {
      try {
        if (window.rubyDung && window.rubyDung.player) {
          window.rubyDung.player.enabled = false;
        }
        if (document.exitPointerLock) try { document.exitPointerLock(); } catch (e) {}
      } catch (e) { console.warn('pauseGame failed', e); }
    }

    function resumeGame() {
      try {
        if (window.rubyDung && window.rubyDung.player) {
          window.rubyDung.player.enabled = true;
        }
      } catch (e) { console.warn('resumeGame failed', e); }
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const visible = modal.style.display === 'flex';
        if (!visible) {
          pauseGame();
          showModal(true);
        } else {
          // ignore when already visible
        }
      }
    }, false);

    applyModalPosition();
    showModal(false);

    try {
      const btn1 = document.getElementById('Button1');
      if (btn1) {
        btn1.addEventListener('click', async (ev) => {
          try {
            if (window.rubyDung && typeof window.rubyDung.regenerateWorld === 'function') {
              await window.rubyDung.regenerateWorld();
            } else {
              console.warn('regenerateWorld not available');
              alert('Regenerate unavailable');
            }
          } catch (err) {
            console.warn('Button1 regen handler failed', err);
          }
        }, { passive: true });
      }
    } catch (e) { console.warn('Button1 wiring failed', e); }

    try {
      const btn2 = document.getElementById('Button2');
      if (btn2) {
        btn2.addEventListener('click', (ev) => {
          try {
            if (window.rubyDung && typeof window.rubyDung.saveWorld === 'function') {
              window.rubyDung.saveWorld();
            } else if (window.rubyDung && typeof window.rubyDung.createWorldBlob === 'function') {
              window.rubyDung.createWorldBlob().then((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'level.dat';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1500);
              }).catch((err) => console.warn('createWorldBlob failed', err));
            } else {
              alert('Save unavailable (game not ready)');
            }
          } catch (err) {
            console.warn('Button2 save handler failed', err);
          }
        }, { passive: true });
      }
    } catch (e) { console.warn('Button2 wiring failed', e); }

    try {
      const btn3 = document.getElementById('Button3');
      if (btn3) {
        btn3.addEventListener('click', (ev) => {
          try {
            // Immediately open the world file picker — do NOT show the load.png overlay here.
            if (window.rubyDung && typeof window.rubyDung.openWorldPicker === 'function') {
              window.rubyDung.openWorldPicker();
            } else if (window.rubyDung && window.rubyDung._worldFileInput) {
              window.rubyDung._worldFileInput.click();
            } else {
              alert('Load unavailable (game not ready)');
            }
          } catch (err) {
            console.warn('Button3 load picker failed', err);
            alert('Load failed: ' + (err && err.message ? err.message : String(err)));
          }
        }, { passive: true });
      }
    } catch (e) { console.warn('Button3 wiring failed', e); }

  } catch (err) {
    console.warn('ESC modal init failed', err);
  }
})();