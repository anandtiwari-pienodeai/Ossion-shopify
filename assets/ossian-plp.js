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

document.querySelectorAll('[data-ossian-plp]').forEach((root) => new OssianPlp(root));
