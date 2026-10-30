#pragma once

#include <Arduino.h>
#include "constants.h"

// https://lastminuteengineers.com/drv8833-arduino-tutorial/

inline void motor_down() {
  digitalWrite(MOTOR_DRIVER_SLEEP_PIN, HIGH);
  digitalWrite(MOTOR_DRIVER_A_INPUT_ONE, HIGH);
  digitalWrite(MOTOR_DRIVER_A_INPUT_TWO, LOW);
}

inline void motor_up() {
  digitalWrite(MOTOR_DRIVER_SLEEP_PIN, HIGH);
  digitalWrite(MOTOR_DRIVER_A_INPUT_ONE, LOW);
  digitalWrite(MOTOR_DRIVER_A_INPUT_TWO, HIGH);
}

inline void motor_off() {
  digitalWrite(MOTOR_DRIVER_A_INPUT_ONE, LOW);
  digitalWrite(MOTOR_DRIVER_A_INPUT_TWO, LOW);
  digitalWrite(MOTOR_DRIVER_SLEEP_PIN, LOW);
}