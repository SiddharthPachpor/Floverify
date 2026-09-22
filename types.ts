/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type PhlebotomyEvent = 'tube_inserted' | 'tourniquet_on' | 'tourniquet_off' | 'none';

export type CapColor =
  | 'blood_culture'
  | 'light_blue'
  | 'red'
  | 'gold'
  | 'green'
  | 'lavender'
  | 'gray'
  | 'none';

export interface DetectionResult {
  event: PhlebotomyEvent;
  cap_color: CapColor;
  tube_in_hand: boolean;
  tube_seated_in_holder: boolean;
  confidence: number;
}

export interface DetectionResponse extends DetectionResult {
  _meta: {
    requestId: string;
    model: string;
    durationMs: number;
    finishReason: string;
    thinkingLevel: string;
    usageMetadata?: {
      promptTokens?: number;
      candidatesTokens?: number;
      totalTokens?: number;
    };
  };
}

export interface Violation {
  type: 'sequence' | 'tourniquet';
  timestamp: number;
  detected?: CapColor;
  previous?: CapColor;
  consequence: string;
  citation: string;
}

export interface ObservedTube {
  cap_color: CapColor;
  timestamp: number;
  valid: boolean;
}

export interface ProtocolStep {
  order: number;
  expect: CapColor;
  rule_type: string;
  consequence: string;
  citation: string;
}

export interface TimingRule {
  rule_type: string;
  trigger: string;
  reset: string;
  limit_seconds: number;
  consequence: string;
  citation: string;
}

export interface ProtocolArtifact {
  protocol_id: string;
  source: string;
  source_url: string;
  steps: ProtocolStep[];
  timing_rules: TimingRule[];
}

export interface AnalysisFrame {
  timestamp: number;
  image: string; // Base64 data URL
  rawDetection?: DetectionResponse;
  debouncedEvent?: {
    event: PhlebotomyEvent;
    cap_color: CapColor;
  };
  accepted?: boolean;
}
