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

/** 어드민 페이지 전용 가드: 로그인 + isAdmin 아니면 대시보드로 돌려보낸다 */
async function requireAdmin() {
  const { ok, data } = await apiFetch('/auth/me');
  if (!ok) { window.location.href = '/sign-in.html?next=' + encodeURIComponent(location.pathname); return null; }
  if (!data.isAdmin) { window.location.href = '/dashboard/index.html'; return null; }
  return data;
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

/* ---------------------------------------------------------------------
 * 공개 페이지 헤더 인증 상태 처리
 * 대상 마크업: <div id="nav-auth"> 안에 로그인/회원가입 버튼이 있어야 함.
 * 로그인 상태면 원형 프로필 아이콘 + 드롭다운(대시보드/내 정보/로그아웃)으로 교체.
 * --------------------------------------------------------------------- */
function initHeaderAuth() {
  const slot = document.getElementById('nav-auth');
  if (!slot) return;

  apiFetch('/auth/me').then(({ ok, data }) => {
    if (!ok || !data?.email) return; // 비로그인: 기존 로그인/회원가입 버튼 그대로 둠

    const initial = (data.email[0] || '?').toUpperCase();
    const isAdmin = !!data.isAdmin;

    slot.innerHTML = `
      <div class="profile-menu">
        <button class="profile-avatar" id="profile-avatar-btn" aria-haspopup="true" aria-expanded="false">${initial}</button>
        <div class="profile-dropdown" id="profile-dropdown">
          <div class="profile-dropdown-email">${data.email}</div>
          <a href="/dashboard/index.html" class="profile-dropdown-item">대시보드로 이동</a>
          <a href="/dashboard/my-information.html" class="profile-dropdown-item">내 정보 관리</a>
          ${isAdmin ? '<a href="/admin/index.html" class="profile-dropdown-item">관리자 페이지</a>' : ''}
          <div class="profile-dropdown-divider"></div>
          <button class="profile-dropdown-item profile-dropdown-signout" id="profile-signout-btn">로그아웃</button>
        </div>
      </div>
    `;

    const btn = document.getElementById('profile-avatar-btn');
    const dropdown = document.getElementById('profile-dropdown');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dropdown.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('profile-signout-btn').addEventListener('click', signOut);
  }).catch(() => {});
}
document.addEventListener('DOMContentLoaded', initHeaderAuth);

/** 대시보드(로그인 전용) 사이드바: 관리자면 "관리자 페이지" 링크를 자동으로 추가한다 */
function injectAdminNavLink() {
  const nav = document.querySelector('.db-nav');
  if (!nav || nav.querySelector('.admin-nav-link')) return;
  apiFetch('/auth/me').then(({ ok, data }) => {
    if (!ok || !data?.isAdmin || location.pathname.startsWith('/admin/')) return;
    const section = document.createElement('div');
    section.className = 'db-nav-section';
    section.textContent = '관리자';
    const link = document.createElement('a');
    link.className = 'db-nav-link admin-nav-link';
    link.href = '/admin/index.html';
    link.innerHTML = '<span class="icon">🛠</span> 관리자 페이지';
    nav.appendChild(section);
    nav.appendChild(link);
  }).catch(() => {});
}
document.addEventListener('DOMContentLoaded', injectAdminNavLink);

/**
 * 호스팅 구매 CTA용: 비로그인 사용자는 회원가입 페이지로,
 * 이미 로그인된 사용자는 바로 대시보드의 "호스팅 만들기" 화면(결제/생성 단계)으로 보낸다.
 * @param {string} planId
 */
async function goToPurchase(planId) {
  const { ok } = await apiFetch('/auth/me');
  if (!ok) {
    window.location.href = '/sign-up.html?plan=' + encodeURIComponent(planId);
    return;
  }
  window.location.href = '/dashboard/index.html?openCreate=1&plan=' + encodeURIComponent(planId);
}
