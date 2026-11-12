# Rapid KL Bus Live

Live map of Rapid KL buses (including MRT feeder buses) using Malaysia's open GTFS data from [data.gov.my](https://developer.data.gov.my/realtime-api/gtfs-realtime).

- Search by bus number, place or stop name
- Pick a route to see its line, stops and live buses in each direction
- Buses that haven't reported for 2+ minutes are shown as dashed and marked out of date
- Positions refresh every 30 seconds

## API (Vercel serverless, no dependencies)

| Endpoint | Returns |
|---|---|
| `/api/buses` | All live buses, labelled with route, direction and destination |
| `/api/catalog` | All routes (with direction names) and stops (with routes serving them) |
| `/api/routes?k=<category>\|<route_id>` | One route's line and ordered stops per direction |
| `/api/live?k=<category>\|<route_id>` | One route's live buses: open feed + MyRapid Kiosk feed merged by number plate |
| `/api/kiosk?route=590` | Check the MyRapid Kiosk live feed for one route |
| `/api/arrivals?s=<category>\|<stop_id>,...` | Next buses at a stop, estimated from distance along the route at ~15 km/h |

Deploy: import this repo at vercel.com/new. No settings needed.

## Features

- **Arrival estimates**: tap any stop to see the next buses and roughly how many minutes away they are
- **Near me**: the target button finds stops within 1.5 km of you
- **Saved**: star routes or stops; they appear as one-tap buttons under the search bar
- **Share**: links open straight to a route (`?route=`), stop (`?stop=`) or a followed bus (`?bus=`)
- **Install**: add to your home screen from the browser menu to use it like an app

## Data sources

- **Open data** (data.gov.my GTFS / GTFS-Realtime): timetable, route lines, stops, and live positions for all buses.
- **MyRapid Bus Kiosk live feed** (unofficial; Socket.IO, base64+gzip JSON): fills in buses missing from the open feed, fetched per route only while someone has that route or stop open, and cached 15 s. Settings: `KIOSK_SID`, `KIOSK_PROVIDER` (default `RKL`) env vars.
