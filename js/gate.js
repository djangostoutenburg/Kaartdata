/* Wachtwoordtoegang voor Kaartdata.
 *
 * Let op: dit is een toegangsdrempel in de browser, geen echte beveiliging. De site staat op
 * GitHub Pages en de broncode is openbaar; wie de code leest, kan het slot omzeilen. Het wachtwoord
 * zelf staat nergens in de code: alleen een PBKDF2-afgeleide (SHA-256, 250.000 rondes) die niet
 * terug te rekenen is. Echte afscherming vraagt hosting met inlog aan de serverkant.
 */
(function () {
  'use strict';

  const SALT = 'kaartdata-toegang-v1';
  const ROUNDS = 250000;
  const HASH = '597d6705380ef2d50bd67a8de3c31d694851cb839380cedaf6dfc74e7be144d7';
  const KEY = 'kaartdata.toegang';

  const root = document.documentElement;
  const form = document.getElementById('gateForm');
  if (!form) return;
  const input = document.getElementById('gatePassword');
  const error = document.getElementById('gateError');
  const button = document.getElementById('gateSubmit');
  const remember = document.getElementById('gateRemember');

  async function derive(password) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ROUNDS }, key, 256);
    return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function unlock() {
    root.classList.remove('locked');
    document.dispatchEvent(new Event('kaartdata:unlocked'));
    window.dispatchEvent(new Event('resize'));
  }

  if (root.classList.contains('locked')) setTimeout(() => input.focus(), 50);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!window.crypto || !crypto.subtle) {
      error.textContent = 'Deze browser kan het wachtwoord niet controleren. Open de site via https.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Controleren…';
    try {
      const h = await derive(input.value);
      if (h !== HASH) {
        error.textContent = 'Onjuist wachtwoord. Probeer het opnieuw.';
        input.select();
        return;
      }
      try {
        (remember.checked ? localStorage : sessionStorage).setItem(KEY, HASH);
      } catch (err) { /* opslag geblokkeerd: dan alleen voor deze keer */ }
      input.value = '';
      unlock();
    } finally {
      button.disabled = false;
      button.textContent = 'Openen';
    }
  });

  document.getElementById('gateShow').addEventListener('click', (e) => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Verberg' : 'Toon';
    input.focus();
  });

  // Vergrendelen (knop in het menu): toegang op dit apparaat vergeten
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#lockApp')) return;
    try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (err) { /* */ }
    root.classList.add('locked');
    setTimeout(() => input.focus(), 50);
  });
})();
