import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="not-found" aria-labelledby="not-found-title">
      <div class="not-found-card">
        <p class="status-code" aria-hidden="true">404</p>
        <h1 id="not-found-title">Page not found</h1>
        <p class="message">
          The page you requested does not exist or may no longer be available.
        </p>
        <a class="dashboard-link" routerLink="/dashboard">Go to Dashboard</a>
      </div>
    </section>
  `,
  styles: [`
    .not-found { min-height: calc(100vh - 145px); display: grid; place-items: center; padding: 32px 16px; }
    .not-found-card { width: min(100%, 560px); padding: 48px 32px; border-radius: 12px; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08); text-align: center; }
    .status-code { margin: 0 0 8px; color: #3b82f6; font-size: 0.875rem; font-weight: 700; letter-spacing: 0.12em; }
    h1 { margin: 0 0 12px; color: #1a1a2e; font-size: 1.75rem; font-weight: 700; }
    .message { margin: 0 auto 24px; max-width: 420px; color: #6b7280; line-height: 1.6; }
    .dashboard-link { display: inline-block; padding: 10px 20px; border-radius: 8px; background: #1a1a2e; color: #fff; font-size: 0.875rem; font-weight: 500; text-decoration: none; }
    .dashboard-link:hover { background: #2a2a4e; }
    .dashboard-link:focus-visible { outline: 3px solid rgba(59, 130, 246, 0.4); outline-offset: 3px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundComponent {}
