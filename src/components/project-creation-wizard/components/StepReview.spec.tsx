import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import StepReview from './StepReview';
import type { WizardFormState } from '../types';

const BASE_FORM_STATE: WizardFormState = {
  workspacePath: '/home/user/my-app',
  githubUrl: '',
  tokenMode: 'none',
  selectedGithubToken: '',
  newGithubToken: '',
};

describe('StepReview', () => {
  it('shows the workspace path and no clone section when there is no GitHub URL', () => {
    render(
      <StepReview
        formState={BASE_FORM_STATE}
        selectedTokenName={null}
        isCreating={false}
        cloneProgress=""
      />,
    );

    expect(screen.getByText('/home/user/my-app')).toBeInTheDocument();
    expect(screen.queryByText('Clone From:')).toBeNull();
    expect(
      screen.getByText(
        'The workspace will be added to your project list and will be available for Claude and Codex sessions.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the clone-from section and "will be cloned" message when a GitHub URL is set', () => {
    render(
      <StepReview
        formState={{ ...BASE_FORM_STATE, githubUrl: 'https://github.com/acme/demo.git' }}
        selectedTokenName={null}
        isCreating={false}
        cloneProgress=""
      />,
    );

    expect(screen.getByText('Clone From:')).toBeInTheDocument();
    expect(screen.getByText('https://github.com/acme/demo.git')).toBeInTheDocument();
    expect(screen.getByText('The repository will be cloned from this folder.')).toBeInTheDocument();
  });

  it('labels a stored token by name when tokenMode is stored', () => {
    render(
      <StepReview
        formState={{
          ...BASE_FORM_STATE,
          githubUrl: 'https://github.com/acme/demo.git',
          tokenMode: 'stored',
          selectedGithubToken: '3',
        }}
        selectedTokenName="work-token"
        isCreating={false}
        cloneProgress=""
      />,
    );

    expect(screen.getByText('Using stored token: work-token')).toBeInTheDocument();
  });

  it('falls back to "Unknown" for a stored token with no resolved name', () => {
    render(
      <StepReview
        formState={{
          ...BASE_FORM_STATE,
          githubUrl: 'https://github.com/acme/demo.git',
          tokenMode: 'stored',
          selectedGithubToken: '3',
        }}
        selectedTokenName={null}
        isCreating={false}
        cloneProgress=""
      />,
    );

    expect(screen.getByText('Using stored token: Unknown')).toBeInTheDocument();
  });

  it('labels a new token as "provided" when tokenMode is new with a value', () => {
    render(
      <StepReview
        formState={{
          ...BASE_FORM_STATE,
          githubUrl: 'https://github.com/acme/demo.git',
          tokenMode: 'new',
          newGithubToken: 'ghp_abc',
        }}
        selectedTokenName={null}
        isCreating={false}
        cloneProgress=""
      />,
    );

    expect(screen.getByText('Using provided token')).toBeInTheDocument();
  });

  it('labels an SSH clone URL as "SSH Key" authentication', () => {
    render(
      <StepReview
        formState={{
          ...BASE_FORM_STATE,
          githubUrl: 'git@github.com:acme/demo.git',
          tokenMode: 'none',
        }}
        selectedTokenName={null}
        isCreating={false}
        cloneProgress=""
      />,
    );

    expect(screen.getByText('SSH Key')).toBeInTheDocument();
  });

  it('labels an https clone URL with no token as "No authentication"', () => {
    render(
      <StepReview
        formState={{
          ...BASE_FORM_STATE,
          githubUrl: 'https://github.com/acme/demo.git',
          tokenMode: 'none',
        }}
        selectedTokenName={null}
        isCreating={false}
        cloneProgress=""
      />,
    );

    expect(screen.getByText('No authentication')).toBeInTheDocument();
  });

  it('shows the live clone progress log while creating', () => {
    render(
      <StepReview
        formState={{ ...BASE_FORM_STATE, githubUrl: 'https://github.com/acme/demo.git' }}
        selectedTokenName={null}
        isCreating
        cloneProgress="Fetching objects: 50% (10/20)"
      />,
    );

    expect(screen.getByText('Cloning repository...')).toBeInTheDocument();
    expect(screen.getByText('Fetching objects: 50% (10/20)')).toBeInTheDocument();
    // The static informational message is replaced while progress is streaming.
    expect(screen.queryByText('The repository will be cloned from this folder.')).toBeNull();
  });

  it('does not show the progress log if isCreating is true but no progress text has arrived yet', () => {
    render(
      <StepReview
        formState={{ ...BASE_FORM_STATE, githubUrl: 'https://github.com/acme/demo.git' }}
        selectedTokenName={null}
        isCreating
        cloneProgress=""
      />,
    );

    expect(screen.queryByText('Cloning repository...')).toBeNull();
    expect(screen.getByText('The repository will be cloned from this folder.')).toBeInTheDocument();
  });
});
