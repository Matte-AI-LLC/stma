/** Small vanilla-JS layer served as /app.js: copy buttons, tabs, confirm dialog, toasts. */
export const clientJs = `(function () {
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

  // Scope filters: a GET form marked data-autosubmit navigates the moment its
  // select changes. The visible View button stays as the no-script path.
  document.addEventListener('change', function (e) {
    var f = e.target.closest && e.target.closest('form[data-autosubmit]');
    if (f) f.submit();
  });

  document.addEventListener('click', function (e) {
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
      var banner = dismiss.closest('.banner');
      if (banner) banner.remove();
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
