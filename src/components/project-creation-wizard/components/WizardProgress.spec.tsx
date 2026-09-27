import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import WizardProgress from './WizardProgress';

describe('WizardProgress', () => {
  it('marks step 1 as current (not yet checked) when step is 1', () => {
    render(<WizardProgress step={1} />);

    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    // Step 1's circle shows the number, not a checkmark, while it's current.
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('marks step 1 complete (checkmark, no "1" label) once step is 2', () => {
    render(<WizardProgress step={2} />);

    expect(screen.queryByText('1')).toBeNull();
    // Step 2 is now current, so its number renders.
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
