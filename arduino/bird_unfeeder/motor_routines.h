#pragma once

#include <Arduino.h>
#include "motor.h"
#include "limit_switch.h"
#include "telemetry.h"

constexpr int LOWER_WEIGHT_DURATION_MS = 5 * 1000;
constexpr int RAISE_WEIGHT_LIMIT_MS = 8 * 1000;

bool raise_weight() {
  if (limit_switch_pressed()) {
    addTelemetryEvent(TelemetryEvent::WEIGHT_ALREADY_AT_TOP_WHEN_RAISING);
    return false;
  }
  addTelemetryEvent(TelemetryEvent::STARTING_RAISE_WEIGHT);
  unsigned long start_time = millis();
  
  motor_up();
  while(!limit_switch_pressed() && millis() - start_time < RAISE_WEIGHT_LIMIT_MS) {
    delay(20);
  }
  unsigned long end_time = millis();
  motor_off();
  if (end_time - start_time >= RAISE_WEIGHT_LIMIT_MS) {
    addTelemetryEvent(TelemetryEvent::RAISE_WEIGHT_FAILURE);
    return false;
  }
  addTelemetryEvent(TelemetryEvent::FINISHED_RAISE_WEIGHT);
  return true;
}

bool lower_weight() {
  if (!limit_switch_pressed()) {
    addTelemetryEvent(TelemetryEvent::WEIGHT_NOT_AT_TOP_WHEN_LOWERING);
    return false;
  }
  addTelemetryEvent(TelemetryEvent::STARTING_LOWER_WEIGHT);
  motor_down();
  delay(LOWER_WEIGHT_DURATION_MS);
  motor_off();
  addTelemetryEvent(TelemetryEvent::FINISHED_LOWER_WEIGHT);
  return true;
}