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

Deploy: import this repo at vercel.com/new. No settings needed.
