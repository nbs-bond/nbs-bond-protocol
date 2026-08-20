import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { NotFoundComponent } from './not-found/not-found.component';

describe('application routes', () => {
  it('renders the not-found page for an unknown route', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    const harness = await RouterTestingHarness.create();

    const component = await harness.navigateByUrl(
      '/nonexistent-route',
      NotFoundComponent,
    );

    expect(component).toBeInstanceOf(NotFoundComponent);
    expect(harness.routeNativeElement?.textContent).toContain('Page not found');
  });
});
