/* CloudPress Bridge — common.js */
const API = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...options.headers },
    ...options,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  return { ok: res.ok, status: res.status, data };
}

/* Toast */
const toastContainer = (() => {
  const el = document.createElement('div');
  el.id = 'toast-container';
  document.body.appendChild(el);
  return el;
})();

function toast(message, type = 'success', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, duration);
}

/* Auth */
async function requireAuth() {
  const { ok, data } = await apiFetch('/auth/me');
  if (!ok) { window.location.href = '/sign-in.html?next=' + encodeURIComponent(location.pathname); return null; }
  return data;
}

async function signOut() {
  await apiFetch('/auth/sign-out', { method: 'POST' });
  window.location.href = '/sign-in.html';
}

/* Modal helpers */
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

/* Format */
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtUsd(cents) { return `$${(cents / 100).toFixed(2)}`; }

/* Active nav link */
function setActiveNav() {
  const path = location.pathname;
  document.querySelectorAll('.db-nav-link').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}
document.addEventListener('DOMContentLoaded', setActiveNav);
