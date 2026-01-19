import React from 'react';

interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
    children: React.ReactNode;
}

export const Panel: React.FC<PanelProps> = ({ children, className = '', ...props }) => {
    return (
        <div
            className={`glass-panel border border-white/5 shadow-2xl ${className}`}
            {...props}
        >
            {children}
        </div>
    );
};
