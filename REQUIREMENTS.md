Build a production-ready **Indian Railways MCP server** that enables an LLM to query and reason over Indian railway data.

The MCP should provide accurate, structured access to relevant railway information such as:

- Railway stations and station codes
- Trains between stations
- Complete train schedules and routes
- Train timings, including arrival/departure and halt durations
- Train running days
- Live train running status
- Train delays and estimated timings
- Seat availability and fares, where reliable data is available
- Nearby railway stations for a given city or location
- Any other railway data that is useful for journey planning

The MCP must support natural journey-planning queries such as:

- Finding trains between two locations
- Finding trains passing through a particular station
- Finding the complete route of a train
- Finding overnight trains
- Finding trains within a particular travel-duration constraint
- Combining multiple trains into a journey
- Finding alternative routes when a direct train does not exist
- Splitting long journeys into multiple railway legs
- Finding suitable railway stations near destinations that don't have convenient direct connectivity

The server should be designed so that the **LLM can compose the available tools itself** to solve complex queries rather than relying on a single hard-coded journey-planning workflow.

Use reliable and legally accessible Indian railway data sources. Prefer authoritative sources where available, and clearly distinguish scheduled, estimated, and actual timings.

The system should be robust enough for real-world use, with appropriate validation, error handling, rate-limit handling, caching where appropriate, and clear structured responses.

It should be implemented as a proper **Model Context Protocol (MCP) server**, compatible with modern MCP clients such as Claude Code and Claude Desktop.

The implementation should be maintainable and extensible so additional railway data providers can be added later without redesigning the MCP interface.

Do not fabricate railway information. When reliable data is unavailable, clearly indicate that the information could not be retrieved.

Reference implementations:
Study the following projects for architecture, data-source discovery, API integrations, MCP tool design, error handling and railway-specific functionality. Do not blindly copy their implementation. Evaluate their approaches and independently choose the best architecture and data sources.
- https://github.com/SharmaVrishab/rail
- https://github.com/amith-vp/indian-railway-mcp
- https://github.com/uditya-kumar/confirmtkt-mcp
- https://glama.ai/mcp/servers/RishiMaddheshiya/indian_railway_mcp-server/tree
- https://github.com/maasir554/indian-railway-mcp-server
- https://github.com/rajprem4214/indian-railways-mcp
- https://github.com/LEKKALAGANESH/Indian-Railway-MCP-Integration
- https://github.com/Aryannath/trainyatri
- https://github.com/lpkumarreddy/railway-mcp-scheduler
- https://github.com/sivab193/indian-rail
- https://github.com/modelcontextprotocol/typescript-sdk
- https://github.com/modelcontextprotocol/python-sdk
- https://modelcontextprotocol.io/specification/latest