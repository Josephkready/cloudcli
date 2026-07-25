import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

import { disabledControlClasses } from './disabledState';

// Keep visual variants centralized so all button usages stay consistent.
//
// The disabled treatment lives in ./disabledState so Button, Input and
// CommandInput cannot drift apart (#276). Note the absence of
// `disabled:pointer-events-none`: a disabled button stays hit-testable so its
// `not-allowed` cursor and `title` tooltip can explain the block. That is safe
// because Button always renders a real <button> (see below), where the native
// `disabled` attribute — not CSS — is what blocks activation.
const buttonVariants = cva(
  `inline-flex touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${disabledControlClasses} [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0`,
  {
    variants: {
      // Every hover/active utility is `enabled:`-scoped. Because Button no
      // longer sets `disabled:pointer-events-none` (see above), :hover and
      // :active match disabled buttons too — and the shared disabled treatment
      // overrides opacity, filter, shadow and cursor but NOT background-color
      // or text-decoration, so an unscoped utility leaks through and a blocked
      // control animates as if it were live. disabledState.test.ts enforces it.
      variant: {
        default:
          'bg-primary text-primary-foreground shadow enabled:hover:bg-primary/90 enabled:active:bg-primary/80',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm enabled:hover:bg-destructive/90 enabled:active:bg-destructive/80',
        outline:
          'border border-input bg-background shadow-sm enabled:hover:bg-accent enabled:hover:text-accent-foreground enabled:active:bg-accent/80',
        secondary:
          'bg-secondary text-secondary-foreground shadow-sm enabled:hover:bg-secondary/80 enabled:active:bg-secondary/70',
        ghost: 'enabled:hover:bg-accent enabled:hover:text-accent-foreground enabled:active:bg-accent/80',
        link: 'text-primary underline-offset-4 enabled:hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3 text-sm',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

// Button has no `asChild`/Slot escape hatch on purpose: it always renders a
// native <button>, so `disabled` genuinely blocks activation and the styling
// above never has to fall back to `pointer-events-none`. `Button.spec.tsx`
// locks that in. `buttonVariants` is also applied to an <a> elsewhere, which is
// fine — `disabled:*` utilities only ever match `:disabled` form controls.
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);

Button.displayName = 'Button';

export { Button, buttonVariants };
