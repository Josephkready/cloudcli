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
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90 active:bg-primary/80',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:bg-destructive/80',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 active:bg-secondary/70',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        link: 'text-primary underline-offset-4 hover:underline',
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
