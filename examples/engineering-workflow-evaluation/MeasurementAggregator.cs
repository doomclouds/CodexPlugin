using System.Globalization;

namespace MeasurementWindow;

internal readonly record struct Measurement(DateTimeOffset TimestampUtc, double Value);

internal readonly record struct WindowSummary(
    DateTimeOffset WindowStartUtc,
    int Count,
    double Mean,
    double Min,
    double Max);

internal static class MeasurementCsv
{
    private static readonly string[] TimestampFormats =
    [
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'",
    ];

    public static IEnumerable<Measurement> Read(TextReader reader)
    {
        ArgumentNullException.ThrowIfNull(reader);

        DateTimeOffset? previousTimestamp = null;
        var lineNumber = 0;

        while (reader.ReadLine() is { } line)
        {
            lineNumber++;
            var text = line.Trim();
            if (text.Length == 0 || text.StartsWith('#'))
            {
                continue;
            }

            var fields = text.Split(',', StringSplitOptions.TrimEntries);
            if (fields.Length != 2)
            {
                throw new FormatException($"Line {lineNumber}: expected timestampUtc,value.");
            }

            if (!DateTimeOffset.TryParseExact(
                    fields[0],
                    TimestampFormats,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var timestamp))
            {
                throw new FormatException($"Line {lineNumber}: timestamp must be an ISO 8601 UTC value ending in Z.");
            }

            if (!double.TryParse(fields[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ||
                !double.IsFinite(value))
            {
                throw new FormatException($"Line {lineNumber}: value must be a finite invariant-culture number.");
            }

            if (previousTimestamp is not null && timestamp < previousTimestamp)
            {
                throw new FormatException($"Line {lineNumber}: timestamps must be non-decreasing.");
            }

            previousTimestamp = timestamp;
            yield return new Measurement(timestamp, value);
        }
    }
}

internal static class MeasurementAggregator
{
    public static IEnumerable<WindowSummary> Aggregate(IEnumerable<Measurement> measurements)
    {
        ArgumentNullException.ThrowIfNull(measurements);

        using var iterator = measurements.GetEnumerator();
        if (!iterator.MoveNext())
        {
            yield break;
        }

        var first = Normalize(iterator.Current);
        var windowStart = FloorToSecond(first.TimestampUtc);
        var previousTimestamp = first.TimestampUtc;
        var count = 1;
        var mean = first.Value;
        var min = first.Value;
        var max = first.Value;

        while (iterator.MoveNext())
        {
            var measurement = Normalize(iterator.Current);
            if (measurement.TimestampUtc < previousTimestamp)
            {
                throw new ArgumentException("Measurements must be ordered by timestamp.", nameof(measurements));
            }

            var nextWindowStart = FloorToSecond(measurement.TimestampUtc);
            if (nextWindowStart != windowStart)
            {
                yield return new WindowSummary(windowStart, count, mean, min, max);
                windowStart = nextWindowStart;
                count = 0;
                mean = 0;
                min = measurement.Value;
                max = measurement.Value;
            }

            count++;
            mean = (((count - 1d) / count) * mean) + (measurement.Value / count);
            min = Math.Min(min, measurement.Value);
            max = Math.Max(max, measurement.Value);
            previousTimestamp = measurement.TimestampUtc;
        }

        yield return new WindowSummary(windowStart, count, mean, min, max);
    }

    private static Measurement Normalize(Measurement measurement)
    {
        if (!double.IsFinite(measurement.Value))
        {
            throw new ArgumentException("Measurement values must be finite.", nameof(measurement));
        }

        return measurement with { TimestampUtc = measurement.TimestampUtc.ToUniversalTime() };
    }

    private static DateTimeOffset FloorToSecond(DateTimeOffset timestamp)
    {
        var ticks = timestamp.UtcDateTime.Ticks;
        return new DateTimeOffset(ticks - (ticks % TimeSpan.TicksPerSecond), TimeSpan.Zero);
    }
}
