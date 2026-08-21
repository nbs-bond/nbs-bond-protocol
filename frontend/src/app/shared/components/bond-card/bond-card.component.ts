import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Bond, AccruedCreditsResponse } from '../../interfaces/bond.interface';
import { StatusBadgeComponent } from '../status-badge/status-badge.component';

@Component({
  selector: 'app-bond-card',
  standalone: true,
  imports: [CommonModule, StatusBadgeComponent],
  template: `
    <div class="bond-card" [class.matured]="bond().status === 'Matured'" [class.defaulted]="bond().status === 'Defaulted'">
      <div class="bond-header">
        <span class="bond-id">Bond #{{ bond().id }}</span>
        <app-status-badge [status]="bond().status" variant="bond" />
      </div>
      <div class="bond-body">
        <div class="bond-field">
          <span class="label">Project</span>
          <span class="value">{{ bond().projectId | slice:0:8 }}...</span>
        </div>
        <div class="bond-field">
          <span class="label">Face Value</span>
          <span class="value">{{ bond().faceValue | number }}</span>
        </div>
        <div class="bond-field">
          <span class="label">Maturity</span>
          <span class="value">{{ bond().maturityDate * 1000 | date }}</span>
        </div>
        <div class="bond-field">
          <span class="label">Credit Type</span>
          <span class="value">{{ bond().creditType }}</span>
        </div>
        <div class="bond-field">
          <span class="label">Subscribed</span>
          <span class="value">{{ bond().totalSubscribed }} / {{ bond().totalSupply }}</span>
        </div>
        <div class="bond-field">
          <span class="label">Coupons</span>
          <span class="value">{{ bond().couponSchedule.length }} payments</span>
        </div>
        @if (accruedCredits(); as acc) {
          <div class="bond-field">
            <span class="label">Accrued Carbon</span>
            <span class="value">{{ accruedAmount('Carbon') | number }}</span>
          </div>
          <div class="bond-field">
            <span class="label">Accrued Biodiversity</span>
            <span class="value">{{ accruedAmount('Biodiversity') | number }}</span>
          </div>
        }
      </div>
      <button *ngIf="bond().status === 'Active'" class="subscribe-btn" (click)="subscribe.emit(String(bond().id))">
        Subscribe
      </button>
    </div>
  `,
  styles: [`
    .bond-card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); border-left: 4px solid #22c55e; }
    .bond-card.matured { border-left-color: #3b82f6; }
    .bond-card.defaulted { border-left-color: #ef4444; }
    .bond-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .bond-id { font-weight: 600; font-size: 1rem; }
    .bond-body { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .bond-field { display: flex; flex-direction: column; }
    .label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
    .value { font-size: 0.875rem; color: #1a1a2e; font-weight: 500; }
    .subscribe-btn { margin-top: 12px; width: 100%; padding: 8px 16px; background: #1a1a2e; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.875rem; }
    .subscribe-btn:hover { background: #2a2a4e; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BondCardComponent {
  readonly bond = input.required<Bond>();
  readonly accruedCredits = input<AccruedCreditsResponse | null>(null);
  readonly subscribe = output<string>();

  accruedAmount(creditType: string): number {
    const acc = this.accruedCredits();
    return (
      acc?.perCreditType.find((e) => e.creditType === creditType)?.amount ?? 0
    );
  }

  String(value: number): string {
    return String(value);
  }
}
