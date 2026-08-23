import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotFoundComponent } from './not-found.component';

describe('NotFoundComponent', () => {
  it('shows a not-found message and a dashboard link', async () => {
    await TestBed.configureTestingModule({
      imports: [NotFoundComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(NotFoundComponent);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const link = element.querySelector('.dashboard-link') as HTMLAnchorElement;

    expect(element.textContent).toContain('Page not found');
    expect(link.textContent).toContain('Go to Dashboard');
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});
