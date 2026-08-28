import * as React from 'react';

import { cn } from '../../../lib/utils';

interface ShimmerProps {
  children: string;
  className?: string;
  as?: React.ElementType;
}

const Shimmer = React.memo<ShimmerProps>(({ children, className, as: Component = 'span' }) => {
  return (
    <Component
      className={cn(
        // The 250% tile width is load-bearing: the `shimmer` keyframes in
        // tailwind.config.js derive their travel from it so one iteration
        // covers a whole number of tiles and the loop never snaps. Changing
        // it here without recomputing them there reintroduces the hitch.
        'animate-shimmer inline-block bg-[length:250%_100%] bg-clip-text text-transparent',
        'bg-[linear-gradient(90deg,transparent_33%,hsl(var(--foreground))_50%,transparent_67%),linear-gradient(hsl(var(--muted-foreground)),hsl(var(--muted-foreground)))]',
        className
      )}
    >
      {children}
    </Component>
  );
});
Shimmer.displayName = 'Shimmer';

export { Shimmer };
