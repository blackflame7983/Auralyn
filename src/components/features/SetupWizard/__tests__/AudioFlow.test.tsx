import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AudioFlow } from '@/components/ui/AudioFlow';

describe('AudioFlow', () => {
    it('経路の順序、未確認、警告と分岐を文言で伝える', () => {
        render(<AudioFlow label="音の経路" unknownLabel="未確認"
            input={{ label: '入力', warning: '入力がありません' }}
            output={{ label: '出力', value: 'Cable', warning: '出力を確認してください' }}
            receiver={{ label: '送り先', value: 'OBS' }}
            branches={[{ label: 'モニター', value: 'Headphones' }, { label: '配信' }]} />);
        const flow = screen.getByRole('region', { name: '音の経路' });
        const steps = within(flow).getAllByRole('listitem');
        expect(steps.slice(0, 2).map(step => step.textContent)).toEqual(['入力未確認入力がありません', 'Auralyn ']);
        const branches = flow.querySelectorAll('[data-flow-branch]');
        expect(branches).toHaveLength(2);
        expect(branches[0]).toHaveTextContent('AuralynモニターHeadphones送り先OBS');
        expect(branches[1]).toHaveTextContent('Auralyn配信未確認送り先OBS');
        expect(flow.querySelector('[data-flow-outputs] > div')).not.toHaveTextContent('OBS');
    });
});
