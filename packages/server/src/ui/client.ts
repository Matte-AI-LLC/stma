/** Small vanilla-JS layer served as /app.js: copy buttons, tabs, confirm dialog, toasts. */
export const clientJs = `(function () {
  var railToggle = document.querySelector('.rail-nav-toggle');
  if (railToggle && window.matchMedia) {
    var rail = railToggle.closest('.rail');
    var narrowRail = window.matchMedia('(max-width: 900px)');
    var railState = function () {
      railToggle.setAttribute('aria-expanded', String(!narrowRail.matches || rail.classList.contains('nav-open')));
    };
    rail.classList.add('nav-ready');
    railToggle.addEventListener('click', function () { rail.classList.toggle('nav-open'); railState(); });
    narrowRail.addEventListener('change', railState);
    railState();
  }
  var launchStatus = document.querySelector('[data-launch-status]');
  if (launchStatus) {
    var launchChecks = 0;
    var checkLaunch = async function () {
      if (document.hidden || ++launchChecks > 24) {
        launchStatus.textContent = 'Automatic checks paused. Refresh status when your agents are ready.';
        return;
      }
      try {
        var response = await fetch(launchStatus.getAttribute('data-launch-status'), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (!response.ok) { launchStatus.textContent = 'Access or connection changed. Refresh or sign in again.'; return; }
        var status = await response.json();
        if (status.exchanged || (launchStatus.hasAttribute('data-launch-first') && String(status.first) !== launchStatus.getAttribute('data-launch-first'))) { window.location.assign(launchStatus.getAttribute('data-launch-refresh') || window.location.href); return; }
        launchStatus.textContent = status.first ? 'Sender observed. Waiting for the second agent to reply.' : 'Waiting for the sender prompt to run.';
      } catch (_) { launchStatus.textContent = 'Could not refresh. Check the server connection; your launch is saved.'; }
      setTimeout(checkLaunch, 5000);
    };
    setTimeout(checkLaunch, 1000);
  }
  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = '<span class="ic">\\u2713</span>';
    el.appendChild(document.createTextNode(msg));
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  // Opening a dialog freezes the page under it. <dialog> does not do this on its
  // own, so the page kept scrolling behind the modal while the modal did not.
  //
  // Released by whichever signal arrives first: the close event is the one the
  // spec offers, and the open attribute is the one that certainly changes. Both,
  // because a lock released by an event that does not arrive leaves the page
  // frozen for good — and measured in Chrome 148, close() did not always fire it.
  function openModal(d) {
    if (!d || !d.showModal) return false;
    d.showModal();
    document.documentElement.classList.add('modal-open');
    var release = function () {
      // Only when the last one has gone: a confirm can open over a form dialog.
      if (d.open || document.querySelector('dialog[open]')) return;
      document.documentElement.classList.remove('modal-open');
      watch.disconnect();
      d.removeEventListener('close', release);
    };
    var watch = new MutationObserver(release);
    watch.observe(d, { attributes: true, attributeFilter: ['open'] });
    d.addEventListener('close', release);
    return true;
  }

  // Belt and braces for the back button. no-store keeps Chrome from restoring a
  // page whole, but Safari has historically put no-store pages in the
  // back/forward cache anyway, and a restored console shows counts it already
  // cleared. The persisted flag is true only for that restore, so a normal load
  // never reloads itself.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });

  // A result band is news once. The parameter that carried it leaves the address
  // as soon as the page has drawn it, so a refresh, a bookmark or a pasted link
  // does not announce again something that happened earlier: "Published v3" on a
  // page reloaded an hour later reads as a second publish. Signed-in pages only;
  // sign-in and consent pages keep their addresses exactly as they were given.
  try {
    var path = window.location.pathname;
    if ((path.indexOf('/app') === 0 || path.indexOf('/admin') === 0) && window.history && history.replaceState) {
      var once = ['ok', 'error', 'err', 'notice', 'assign_error', 'assigned', 'cancelled', 'handoff', 'checkout', 'change'];
      var here = new URL(window.location.href);
      var had = false;
      once.forEach(function (key) {
        if (here.searchParams.has(key)) { here.searchParams.delete(key); had = true; }
      });
      if (had) {
        var rest = here.searchParams.toString();
        history.replaceState(history.state, '', here.pathname + (rest ? '?' + rest : '') + here.hash);
      }
    }
  } catch (_) {}

  // Scope filters: a GET form marked data-autosubmit navigates the moment its
  // select changes. The visible View button stays as the no-script path.
  document.addEventListener('change', function (e) {
    var f = e.target.closest && e.target.closest('form[data-autosubmit]');
    if (f) f.submit();
  });

  // Every notice can be put away, and the control is added here rather than in
  // the markup for the reason the scope pickers are <details>: dismissing is a
  // script-only act, so without script there is nothing the button could do and
  // it should not be drawn. A band marked data-keep is one whose state ends when
  // somebody acts on it — the unconfirmed address — and it keeps no control.
  //
  // The dismissal lasts the browser session, keyed on what the band says. A
  // warning whose wording changes is a different warning and comes back, which
  // is what "this snapshot is 41 days old" does the day it turns 42.
  function bandKey(el) {
    return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  }
  document.querySelectorAll('.banner:not([data-keep]), .band2:not([data-keep])').forEach(function (band) {
    // Read before the control is added, or the key would carry the button's own
    // glyph and never match the one stored when it was clicked.
    var key = bandKey(band);
    band.setAttribute('data-band-key', key);
    try {
      if (sessionStorage.getItem('stma.band.' + key)) { band.remove(); return; }
    } catch (_) {}
    if (band.querySelector('[data-dismiss]')) return;
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.setAttribute('data-dismiss', '');
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    band.appendChild(x);
  });

  // Scope pickers are <details>, so they work with no script. With one, a click
  // anywhere else closes them, and opening one closes the other: a menu left
  // hanging over the page reads as a page that is stuck. The rail's workspace
  // switcher is one of them; as an <a> it has no open attribute to remove, so
  // naming it here costs nothing when there is nowhere to switch to.
  document.addEventListener('click', function (e) {
    var inside = e.target.closest && e.target.closest('.scope-pick, details.rail-ws');
    document.querySelectorAll('.scope-pick[open], details.rail-ws[open]').forEach(function (menu) {
      if (menu !== inside) menu.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.scope-pick[open], details.rail-ws[open]').forEach(function (menu) {
      menu.removeAttribute('open');
    });
  });

  document.addEventListener('click', function (e) {
    var detailsLink = e.target.closest('[data-open-details]');
    if (detailsLink) {
      var details = document.getElementById(detailsLink.getAttribute('data-open-details'));
      if (details && details.tagName === 'DETAILS') details.open = true;
    }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      var text = copy.getAttribute('data-copy');
      navigator.clipboard.writeText(text).then(function () {
        var prev = copy.textContent;
        copy.classList.add('copied');
        copy.textContent = '\\u2713 COPIED';
        toast('Copied to clipboard');
        setTimeout(function () {
          copy.classList.remove('copied');
          copy.textContent = prev;
        }, 1600);
      });
      return;
    }
    var tab = e.target.closest('[data-tab]');
    if (tab) {
      var group = tab.closest('[data-tabs]');
      var scope = group.parentElement;
      while (scope && !scope.querySelector('[data-tab-panel]')) scope = scope.parentElement;
      scope = scope || document;
      group.querySelectorAll('[data-tab]').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var name = tab.getAttribute('data-tab');
      scope.querySelectorAll('[data-tab-panel]').forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-tab-panel') === name);
      });
      return;
    }
    var dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) {
      var banner = dismiss.closest('.banner, .band2');
      if (banner) {
        var bk = banner.getAttribute('data-band-key') || bandKey(banner);
        try { sessionStorage.setItem('stma.band.' + bk, '1'); } catch (_) {}
        banner.remove();
      }
      return;
    }
    var opener = e.target.closest('[data-open-dialog]');
    if (opener) {
      e.preventDefault();
      openModal(document.querySelector(opener.getAttribute('data-open-dialog')));
      return;
    }
    var demo = e.target.closest('[data-demo-email]');
    if (demo) {
      e.preventDefault();
      var emailInput = document.querySelector('input[name="email"]');
      var pwInput = document.querySelector('input[name="password"]');
      if (emailInput) emailInput.value = demo.getAttribute('data-demo-email');
      if (pwInput) pwInput.value = demo.getAttribute('data-demo-password');
      if (emailInput) emailInput.focus();
      toast('Filled in — press Sign in');
      return;
    }
    var closer = e.target.closest('[data-close-dialog]');
    if (closer) {
      e.preventDefault();
      var dd = closer.closest('dialog');
      if (dd) dd.close();
    }
  });

  // Direct links from Needs attention or a copied URL should reveal the
  // collapsed section instead of scrolling to an opaque closed card.
  if (window.location.hash) {
    var fragment = document.getElementById(window.location.hash.slice(1));
    if (fragment && fragment.tagName === 'DETAILS') fragment.open = true;
  }

  // Deep links from a project can arrive with the team and project already
  // selected. Opening the form on load keeps that context instead of making the
  // user click New session and re-enter where they came from.
  //
  // A dialog the server also rendered open needs no script at all, which is how
  // the Assign work ticket picker draws a list without one. With script it
  // should be a modal like every other dialog here, and showModal() refuses an
  // element that already carries the open attribute, so close it first.
  var autoDialog = document.querySelector('dialog[data-auto-open]');
  if (autoDialog) {
    if (autoDialog.open) autoDialog.close();
    openModal(autoDialog);
  }

  // The session form can span several teams, but a project belongs to exactly
  // one. Keep impossible cross-team choices out of the picker as the team
  // changes; the POST handler independently enforces the same boundary.
  var sessionTeam = document.querySelector('[data-session-team]');
  var sessionProject = document.querySelector('[data-session-project]');
  if (sessionTeam && sessionProject) {
    var syncSessionProjects = function () {
      var selected = sessionProject.options[sessionProject.selectedIndex];
      var selectedTeam = selected && selected.getAttribute('data-team');
      if (selectedTeam && selectedTeam !== sessionTeam.value) sessionProject.value = '';
      sessionProject.querySelectorAll('option[data-team]').forEach(function (option) {
        var belongs = option.getAttribute('data-team') === sessionTeam.value;
        option.hidden = !belongs;
        option.disabled = !belongs;
      });
    };
    sessionTeam.addEventListener('change', syncSessionProjects);
    syncSessionProjects();
  }

  // Gentle auto-refresh for watch pages (sessions list): never while a dialog
  // is open or the user is typing.
  if (document.querySelector('[data-autorefresh]')) {
    // Freeze: a live page that reloads under you while you are reading a run is
    // hostile. The state lives in sessionStorage so it survives the reloads it
    // is switching off, and the strip says which mode you are in.
    var frozen = sessionStorage.getItem('stma-frozen') === '1';
    var live = false;
    var paint = function () {
      document.querySelectorAll('[data-freeze]').forEach(function (b) {
        b.textContent = frozen ? String(b.dataset.frozenLabel || 'Resume live') : String(b.dataset.liveLabel || 'Freeze view');
        b.setAttribute('aria-pressed', frozen ? 'true' : 'false');
      });
      document.querySelectorAll('[data-freeze-state]').forEach(function (el) {
        // The strip says what is actually true: frozen, streaming, or on the timer.
        el.textContent = frozen ? 'frozen' : live ? 'live' : String(el.dataset.freezeState || 'poll 30s');
        el.className = frozen ? 'dim' : '';
      });
    };
    paint();
    document.querySelectorAll('[data-freeze]').forEach(function (b) {
      b.addEventListener('click', function () {
        frozen = !frozen;
        sessionStorage.setItem('stma-frozen', frozen ? '1' : '0');
        paint();
      });
    });
    var refreshable = function () {
      var ae = document.activeElement;
      var typing = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.tagName === 'SELECT');
      return !frozen && !document.querySelector('dialog[open]') && !typing;
    };

    // Live channel. The server says when something changed; the poll below stays
    // as the fallback, so a dropped stream costs latency and never correctness.
    // Seeded at load, not 0: this page is itself as fresh as an event, and
    // leaving it at 0 made the "heard from recently" test compare against 1970,
    // so the 30s fallback reloaded every turn while the stream was healthy —
    // the behaviour the stream was added to replace.
    var lastEventAt = Date.now();
    var pending = null;
    if (window.EventSource) {
      var es = new EventSource('/app/stream');
      es.addEventListener('ready', function () {
        live = true;
        paint();
      });
      es.addEventListener('change', function () {
        lastEventAt = Date.now();
        // One reload per burst: several agents finishing at once is one page.
        if (pending) return;
        pending = setTimeout(function () {
          pending = null;
          if (refreshable()) window.location.reload();
        }, 400);
      });
      es.addEventListener('error', function () {
        // EventSource reconnects by itself; until it does, say so in the strip.
        live = false;
        paint();
      });
      window.addEventListener('beforeunload', function () { es.close(); });
    }

    setInterval(function () {
      // With the stream connected and recently heard from, the timer has nothing
      // to add — reloading anyway is the behaviour this replaced.
      if (live && Date.now() - lastEventAt < 120000) return;
      if (refreshable()) window.location.reload();
    }, 30000);
  }

  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (f.dataset.confirmed) return;
      e.preventDefault();
      var dlg = document.getElementById('confirm-dialog');
      if (!dlg || !dlg.showModal) {
        if (window.confirm(f.dataset.confirm || 'Are you sure?')) {
          f.dataset.confirmed = '1';
          f.submit();
        }
        return;
      }
      dlg.querySelector('[data-dlg-title]').textContent = f.dataset.confirmTitle || 'Are you sure?';
      dlg.querySelector('[data-dlg-body]').textContent = f.dataset.confirm || '';
      var okBtn = dlg.querySelector('[data-dlg-ok]');
      okBtn.textContent = f.dataset.confirmAction || 'Confirm';
      dlg.returnValue = '';
      dlg.onclose = function () {
        if (dlg.returnValue === 'ok') {
          f.dataset.confirmed = '1';
          f.submit();
        }
      };
      openModal(dlg);
    });
  });
})();
`;
