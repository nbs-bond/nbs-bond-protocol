import { Component, inject, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BROWSER_WINDOW } from './freighter.tokens';
import { freighterInstallTarget } from './freighter-install';

@Component({
  selector: 'app-freighter-install-prompt',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="install-prompt" role="alert">
      <h2>Freighter wallet not found</h2>
      <p>
        Signing in needs the Freighter browser extension. Install it, then retry the
        connection — no page reload required.
      </p>
      <a class="btn btn-primary" [href]="target.url" target="_blank" rel="noopener noreferrer">
        Get Freighter from the {{ target.storeName }}
      </a>
      <button type="button" class="btn btn-link" (click)="retry.emit()">
        I have installed it — retry
      </button>
    </div>
  `,
  styles: [`
    .install-prompt { background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 16px; text-align: left; }
    h2 { font-size: 1rem; margin: 0 0 8px; color: #9a3412; }
    p { color: #7c2d12; font-size: 0.875rem; margin: 0 0 12px; }
    .btn { padding: 10px 16px; border: none; border-radius: 8px; font-size: 0.875rem; cursor: pointer; width: 100%; }
    .btn-primary { display: block; background: #1a1a2e; color: #fff; text-align: center; text-decoration: none; box-sizing: border-box; }
    .btn-link { background: transparent; color: #7c2d12; text-decoration: underline; margin-top: 8px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FreighterInstallPromptComponent {
  private readonly window = inject(BROWSER_WINDOW);

  /** Store link for the current browser, resolved once — the browser cannot change. */
  readonly target = freighterInstallTarget(this.window.navigator);

  readonly retry = output<void>();
}
