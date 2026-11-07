# CROW: Community Recording Online Workflow

The CROW app is used for configuring AudioMoth devices and running species detections on AudioMoth recordings. See [Greater Seattle Soundscape Monitoring Project](https://seattle-soundscape.uw.edu) for more information about the project.

## Flashing AudioMoths

After logging in, you can flash any connected AudioMoth to the preset setting with the latest firmware:
Sample rate: 192 kHz
Duty cycle: 5 min recording / 5 min sleep
Schedule: 00:00-24:00

The voltage reading of the AudioMoth batteries will also be displayed.

## Detecting Species

The app can run detections on an AudioMoth SD card structure ready for upload to the webportal. You will be prompted to select a location and inventory item before, logging in and selecting the correct settings is essential to populate the META.TXT file properly. BirdNET 2.4 and BattyBirdNET 1.0 USA-WEST are used.

### More models

A selection of extra models from the [bioacoustics model zoo](https://github.com/kitzeslab/bioacoustics-model-zoo) can be used as well. This requires an add-on download of Python and packages, as well as the selected models (completed automatically).

## Signing in

The app currently requires signing in to configure AudioMoths and run detections using the models. Use the same credentials as you would on the webportal.

## OS Specifics

- **macOS:** The app may be blocked on open, go to **System Settings -> Privacy & Security** and click **Open Anyway**. Detection is not supported on Intel macs.

- **Linux:** To connect AudioMoths, create `/etc/udev/rules.d/99-audiomoth.rules` containing:
  ```
  SUBSYSTEM=="usb", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="0002", MODE="0666"
  SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="0003", MODE="0666"
  ```
  Then run `sudo udevadm control --reload-rules` and reconnect the AudioMoth.

## Licenses

`audiomoth-hid` and the bundled `flash` binaries are MIT-licensed by Open Acoustic Devices. The EFM32-Flash license is in `bin/`.

The BirdNET and BattyBirdNET models are licensed [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/): non-commercial use only, with attribution (see `models/README.md`).