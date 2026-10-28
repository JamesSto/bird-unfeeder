#pragma once

#include <Arduino.h>
#include "constants.h"

inline bool limit_switch_pressed() {
  return digitalRead(LIMIT_SWITCH_PIN) == LOW;
}