class OssianPlp {
  constructor(root) {
    this.root = root;
    this.form = root.querySelector('[data-ossian-plp-form]');
    this.drawer = root.querySelector('[data-ossian-plp-drawer]');
    this.backdrop = root.querySelector('[data-ossian-plp-backdrop]');

    root.querySelectorAll('[data-ossian-plp-drawer-open]').forEach((button) => {
      button.addEventListener('click', () => this.openDrawer());
    });

    root.querySelectorAll('[data-ossian-plp-drawer-close]').forEach((element) => {
      element.addEventListener('click', () => this.closeDrawer());
    });

    this.handleKeydown = (event) => {
      if (event.key === 'Escape') this.closeDrawer();
    };

    if (this.form) {
      this.form.addEventListener('change', (event) => {
        if (event.target.matches('input[type="checkbox"], input[type="number"]')) {
          this.submitForm();
        }
      });
    }

    root.querySelectorAll('[data-ossian-plp-sort]').forEach((select) => {
      select.addEventListener('change', () => this.submitForm());
    });

    root.querySelectorAll('[data-ossian-sort-menu]').forEach((menu) => new OssianSortMenu(menu));
  }

  submitForm() {
    if (!this.form) return;
    if (typeof this.form.requestSubmit === 'function') {
      this.form.requestSubmit();
    } else {
      this.form.submit();
    }
  }

  openDrawer() {
    if (!this.drawer) return;
    this.drawer.classList.add('is-open');
    this.backdrop?.classList.add('is-open');
    document.documentElement.classList.add('ossian-plp-scroll-lock');
    document.addEventListener('keydown', this.handleKeydown);
  }

  closeDrawer() {
    if (!this.drawer) return;
    this.drawer.classList.remove('is-open');
    this.backdrop?.classList.remove('is-open');
    document.documentElement.classList.remove('ossian-plp-scroll-lock');
    document.removeEventListener('keydown', this.handleKeydown);
  }
}

/**
 * Styled listbox for the sort options. Drives the native <select> (kept for no-JS), so a choice
 * fires the select's change event and the existing form submission runs.
 */
class OssianSortMenu {
  constructor(menu) {
    this.menu = menu;
    this.wrapper = menu.closest('.ossian-plp__sort');
    this.select = this.wrapper?.querySelector('[data-ossian-plp-sort]');
    this.trigger = menu.querySelector('[data-ossian-sort-trigger]');
    this.list = menu.querySelector('[data-ossian-sort-list]');
    this.current = menu.querySelector('[data-ossian-sort-current]');
    this.options = Array.from(menu.querySelectorAll('[role="option"]'));
    if (!this.select || !this.trigger || !this.list || this.options.length === 0) return;

    this.activeIndex = Math.max(0, this.options.findIndex((o) => o.getAttribute('aria-selected') === 'true'));
    this.typed = '';
    this.typedTimer = 0;

    menu.hidden = false;
    this.wrapper.classList.add('is-enhanced');

    this.trigger.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.trigger.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        this.open();
      }
    });
    this.list.addEventListener('keydown', (event) => this.onListKeydown(event));
    this.list.addEventListener('click', (event) => {
      const option = event.target.closest('[role="option"]');
      if (option) this.choose(this.options.indexOf(option));
    });
    this.list.addEventListener('mousemove', (event) => {
      const option = event.target.closest('[role="option"]');
      if (option) this.setActive(this.options.indexOf(option), false);
    });
    this.onDocumentClick = (event) => {
      if (!this.menu.contains(event.target)) this.close(false);
    };
  }

  get isOpen() {
    return this.trigger.getAttribute('aria-expanded') === 'true';
  }

  open() {
    if (this.isOpen) return;
    this.list.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.setActive(this.activeIndex);
    this.list.focus();
    document.addEventListener('click', this.onDocumentClick, true);
  }

  close(returnFocus = true) {
    if (!this.isOpen) return;
    this.list.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.list.removeAttribute('aria-activedescendant');
    document.removeEventListener('click', this.onDocumentClick, true);
    if (returnFocus) this.trigger.focus();
  }

  setActive(index, scroll = true) {
    if (index < 0 || index >= this.options.length) return;
    this.activeIndex = index;
    this.options.forEach((option, i) => option.classList.toggle('is-active', i === index));
    const option = this.options[index];
    this.list.setAttribute('aria-activedescendant', option.id);
    if (scroll) option.scrollIntoView({ block: 'nearest' });
  }

  choose(index) {
    const option = this.options[index];
    if (!option) return;
    this.options.forEach((o) => o.setAttribute('aria-selected', String(o === option)));
    this.current.textContent = option.textContent.trim();
    this.close();
    if (this.select.value !== option.dataset.value) {
      this.select.value = option.dataset.value;
      this.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  onListKeydown(event) {
    const last = this.options.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.setActive(Math.min(last, this.activeIndex + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.setActive(Math.max(0, this.activeIndex - 1));
        break;
      case 'Home':
        event.preventDefault();
        this.setActive(0);
        break;
      case 'End':
        event.preventDefault();
        this.setActive(last);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.choose(this.activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'Tab':
        this.close(false);
        break;
      default:
        // Type-ahead: jump to the first option starting with the typed letters
        if (event.key.length === 1 && /\S/.test(event.key)) {
          clearTimeout(this.typedTimer);
          this.typed += event.key.toLowerCase();
          this.typedTimer = setTimeout(() => (this.typed = ''), 600);
          const match = this.options.findIndex((o) => o.textContent.trim().toLowerCase().startsWith(this.typed));
          if (match >= 0) this.setActive(match);
        }
    }
  }
}

document.querySelectorAll('[data-ossian-plp]').forEach((root) => new OssianPlp(root));
