import React from 'react';

export const Card = ({ className = '', children, ...props }) => {
  const classes = `rounded-lg border bg-card text-card-foreground shadow-sm ${className}`;
  
  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
};

export const CardHeader = ({ className = '', children, ...props }) => {
  const classes = `flex flex-col space-y-1.5 p-6 ${className}`;
  
  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
};

export const CardTitle = ({ className = '', children, ...props }) => {
  const classes = `text-2xl font-semibold leading-none tracking-tight ${className}`;
  
  return (
    <h3 className={classes} {...props}>
      {children}
    </h3>
  );
};

export const CardDescription = ({ className = '', children, ...props }) => {
  const classes = `text-sm text-muted-foreground ${className}`;
  
  return (
    <p className={classes} {...props}>
      {children}
    </p>
  );
};

export const CardContent = ({ className = '', children, ...props }) => {
  const classes = `p-6 pt-0 ${className}`;
  
  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
};

export const CardFooter = ({ className = '', children, ...props }) => {
  const classes = `flex items-center p-6 pt-0 ${className}`;
  
  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
};
