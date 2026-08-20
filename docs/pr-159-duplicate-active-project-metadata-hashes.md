# PR Title

Prevent duplicate active project metadata hash registrations in property tests

# PR Body

## Summary

- Reuse the project ID registered by `deploy_with_holders` across the coupon-engine property tests.
- Prevent `setup_project` from registering the same project metadata hash more than once during a test.

## Problem

`setup_project` registers a project as a side effect before returning its metadata hash. `deploy_with_holders` already calls it to configure the bond, but the property-test helpers called it again to submit reports. With active-project metadata-hash deduplication enabled, those duplicate registrations fail because the original project is still active.

The multi-period property test also repeated the registration once per period, causing the same collision on each subsequent report.

## Solution

`deploy_with_holders` now returns the `project_id` it registered. `setup_with_balances` and `multi_period_conserves_credits` reuse that ID when submitting reports instead of registering another project with the same hash.

## Testing

- `cargo test -p nbbs-coupon-engine --lib 'test::property::distribution_conserves_credits' -- --exact`
- `cargo test -p nbbs-coupon-engine --lib 'test::property::multi_period_conserves_credits' -- --exact`