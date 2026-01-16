# Open-Source Multi-Chemistry BMS for Tiny Social Robots (BSc/MSc)

* Survey emerging sodium-ion battery technology and BMS requirements for small-form-factor devices.
* Design and implement an open-source, multi-chemistry Battery Management System supporting Na-ion, LiFePO4, and Li-ion 18650 cells.
* Integrate with RSC v5 carrier board and evaluate thermal/safety characteristics.
* Target OSHWA certification and publish reference design for the maker/robotics community.

---

## Extended Description

### Background

The RSC project requires a reliable, safe, and affordable battery solution. Sodium-ion technology offers compelling safety benefits (no thermal runaway, 0V storage capability) and sustainability advantages, but lacks mature BMS solutions for small devices. This thesis addresses that gap.

### Tentative Research Questions

1. What are the technical requirements for a BMS supporting multiple 18650 chemistries (Na-ion, LiFePO4, Li-ion)?
2. How might open-source BMS designs (e.g., Libre Solar BMS-C1) be adapted for compact 3-4S applications?
3. What firmware modifications are needed to support Na-ion's unique voltage curves and thresholds?
4. How does Na-ion perform in a real social robot application (thermal behavior, runtime, cycle life)?

### Deliverables

1. **Literature Review:** Na-ion technology state-of-the-art, BMS IC landscape, open-source BMS projects
2. **Hardware Design:** KiCad schematic and PCB for 3S1P multi-chemistry BMS
   - BQ76942 AFE integration
   - USB-C PD input compatibility
   - I2C interface for host MCU telemetry
   - JLCPCB PCBA-ready design
3. **Firmware:** (Zephyr RTOS-based firmware) with configurable (auto-detect?) chemistry profiles
4. **Evaluation:** Bench test characterisation and integration with RSC prototype
5. **Documentation:** OSHWA-ready documentation, build guide, and contribution to RSC open-source repository

### Skills Developed

- PCB design (KiCad)
- Embedded systems (Zephyr RTOS, I2C bus)
- Battery chemistry fundamentals
- Open-source hardware practices
- Technical documentation

### Prerequisites

- Basic electronics knowledge
- Familiarity with KiCad or willingness to learn
- Interest in sustainable technology

### Supervision

- Primary: Farnaz Baksh
- Technical: Matevž Zorec (and/or External)

### Possible Timeline

| Phase | Duration | Activities |
|-------|----------|------------|
| 1 | 4 weeks | Literature review, BMS IC selection |
| 2 | 6 weeks | Schematic design, component sourcing |
| 3 | 4 weeks | PCB layout, PCBA order |
| 4 | 4 weeks | Firmware development |
| 5 | 4 weeks | Testing, RSC integration |
| 6 | 4 weeks | Documentation, thesis writing |

### Related RSC Topics

- RSC Gets a HAT (carrier board integration)
- IoT Gateway (power management for always-on operation)

### External Collaboration Potential

- **Libre Solar / EnAccess:** Upstream contribution to BMS-C1 project
- **OSHWA:** Certification process documentation
- **Na-ion community:** First open-source small-device BMS reference

---

## Keywords

`sodium-ion` `BMS` `open-source hardware` `KiCad` `BQ76942` `OSHWA` `18650` `multi-chemistry` `Zephyr RTOS` `social robotics`


---


# Appendix

---


## Notes on RSC Na-Ion BMS Investigation Summary

**Date:** January 2026  
**Context:** RSC v5 power subsystem design  
**Status:** Research / Thesis Topic Candidate

---

## Key Question

Should RSC v5 adopt sodium-ion 18650 cells instead of traditional Li-ion?

## Na-Ion Tradeoffs

| Aspect | Na-Ion | Li-Ion |
|--------|--------|--------|
| Energy Density | ~100-160 Wh/kg | ~250 Wh/kg |
| Safety | No thermal runaway, can discharge to 0V | Fire/explosion risk |
| Cost Trend | Dropping fast (~$59/kWh in 2025) | ~$52/kWh (LFP) |
| Cycle Life | 3,000-10,000+ cycles | 500-2,000 cycles |
| Cold Performance | Excellent (-30°C @ 92% capacity) | Poor below 0°C |
| Voltage Range | 1.5V - 4.1V (wider swing) | 2.5V - 4.2V |

## RSC v5 Power Constraints

- **Target:** 4-8 hrs standby/idle
- **Form factor:** Max 3x 18650 cells (compact desktop companion)
- **Peak draw:** 5-9A (CM5 + peripherals under load)
- **Input:** USB-C PD @ 20V

## The Problem

Typical Na-ion 18650 specs (e.g., HAKADI 1500mAh):
- Standard discharge: 0.5C (0.75A)
- Max continuous: 3C (4.5A)
- Max peak: 5C (~7.5A)

**3S1P = 4.5A continuous** → insufficient for 5-9A peak demand  
**3S2P = 9A continuous** → requires 6 cells (exceeds form factor!)

## BMS Challenge

No dedicated Na-ion BMS ICs exist. Current solutions:
1. **Configurable ICs** (TI BQ76952/BQ76942) - programmable thresholds
2. **Smart Chinese BMS boards** (JK BMS: 1.2V-4.35V range)
3. **Discrete protection circuits** - for simple low-power applications

## Open Source BMS Landscape

| Project | Notes |
|---------|-------|
| **Libre Solar BMS-C1** | BQ76952 + ESP32-C3, KiCad, CERN OHL v2, 16S/100A |
| **ENNOID-BMS** | LTC68XX + STM32, modular, EV-scale |
| **diyBMSv4** | Per-cell modules, JLCPCB-friendly |
| **Green-BMS** | OSHWA certified (IT000007) |

**Gap identified:** No open-source Na-ion BMS for small devices (3S-4S, <10A).

## Proposed Contribution

**RSC Na-Ion BMS Mini** - multi-chemistry open-source BMS:
- 3S-4S support (Na-ion, LiFePO4, Li-ion configurable)
- 10A continuous / 15A peak
- BQ76942 AFE + microcontroller
- USB-C PD integration (align with RSC carrier board)
- I2C telemetry to CM4/CM5
- JLCPCB PCBA compatible
- OSHWA certification target

## Practical Paths for RSC v5

1. **Accept limitation:** 3S1P Na-ion, limit to 4-5A, rely on USB-C PD for heavy loads
2. **Larger pack:** 3S2P (6 cells) with slightly larger enclosure
3. **Wait for 21700 Na-ion:** Higher capacity cells emerging
4. **Pragmatic hybrid:** LiFePO4 now, design BMS for multi-chemistry future-proofing

---

## References

- Libre Solar BMS-C1: https://github.com/LibreSolar/bms-c1
- HAKADI Na-ion cells: hakadibattery.com
- TI BQ76942 datasheet: ti.com/product/BQ76942
- CATL Naxtra (2025): 175 Wh/kg, 5C charging, 10,000+ cycles