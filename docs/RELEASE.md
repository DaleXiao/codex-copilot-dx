# CCDX 1.3.13

Improves CPU checks for groups of short local-masking fields while preserving each field's independent detection context.

- Schedules short CPU sequences together within the existing core and memory budgets, reducing repeated thread setup.
- Preserves per-field tokenization, positions, attention, quantization and restored values. A single uncached append, cached checks and long or accelerator-eligible inputs retain their existing paths.
- Reports short CPU batch groups and computed windows through existing masking diagnostics. Existing controls and model weights are unchanged.

New long histories can still take time to check. Performance observations do not replace complete-check-before-send, cancellation recovery or classifier correctness.

Unverified: sustained real-use performance and signed Claude App UI acceptance.
