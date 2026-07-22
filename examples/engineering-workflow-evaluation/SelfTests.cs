namespace MeasurementWindow;

internal static class SelfTests
{
    public static int Run()
    {
        (string Name, Action Test)[] tests =
        [
            ("aggregates second windows", AggregatesSecondWindows),
            ("skips empty windows", SkipsEmptyWindows),
            ("accepts empty input", AcceptsEmptyInput),
            ("reports malformed line", ReportsMalformedLine),
            ("rejects non-finite value", RejectsNonFiniteValue),
            ("reports out-of-order line", ReportsOutOfOrderLine),
            ("protects direct aggregation", ProtectsDirectAggregation),
            ("keeps extreme mean finite", KeepsExtremeMeanFinite),
        ];

        var failures = 0;
        foreach (var (name, test) in tests)
        {
            try
            {
                test();
                Console.WriteLine($"PASS {name}");
            }
            catch (Exception exception)
            {
                failures++;
                Console.Error.WriteLine($"FAIL {name}: {exception.Message}");
            }
        }

        Console.WriteLine($"{tests.Length - failures}/{tests.Length} passed");
        return failures == 0 ? 0 : 1;
    }

    private static void AggregatesSecondWindows()
    {
        const string input = """
            # timestampUtc,value
            2026-07-22T10:00:00.100Z,1
            2026-07-22T10:00:00.900Z,3

            2026-07-22T10:00:01Z,10
            """;

        var summaries = ReadAndAggregate(input);
        Equal(2, summaries.Length);
        Equal(new DateTimeOffset(2026, 7, 22, 10, 0, 0, TimeSpan.Zero), summaries[0].WindowStartUtc);
        Equal(2, summaries[0].Count);
        Near(2, summaries[0].Mean);
        Near(1, summaries[0].Min);
        Near(3, summaries[0].Max);
        Equal(new DateTimeOffset(2026, 7, 22, 10, 0, 1, TimeSpan.Zero), summaries[1].WindowStartUtc);
        Equal(1, summaries[1].Count);
        Near(10, summaries[1].Mean);
    }

    private static void AcceptsEmptyInput() => Equal(0, ReadAndAggregate("# no data\n\n").Length);

    private static void SkipsEmptyWindows()
    {
        var summaries = ReadAndAggregate(
            "2026-07-22T10:00:00Z,1\n2026-07-22T10:00:02Z,2");

        Equal(2, summaries.Length);
        Equal(new DateTimeOffset(2026, 7, 22, 10, 0, 2, TimeSpan.Zero), summaries[1].WindowStartUtc);
    }

    private static void ReportsMalformedLine() =>
        Throws<FormatException>(
            () => ReadAndAggregate("2026-07-22T10:00:00Z,1\nbad"),
            "Line 2");

    private static void RejectsNonFiniteValue() =>
        Throws<FormatException>(
            () => ReadAndAggregate("2026-07-22T10:00:00Z,NaN"),
            "Line 1");

    private static void ReportsOutOfOrderLine() =>
        Throws<FormatException>(
            () => ReadAndAggregate(
                "2026-07-22T10:00:01Z,1\n2026-07-22T10:00:00Z,2"),
            "Line 2");

    private static void ProtectsDirectAggregation()
    {
        var later = new DateTimeOffset(2026, 7, 22, 10, 0, 1, TimeSpan.Zero);
        var earlier = later.AddSeconds(-1);

        Throws<ArgumentException>(
            () => MeasurementAggregator.Aggregate(
                [new Measurement(later, 1), new Measurement(earlier, 2)]).ToArray(),
            "ordered");
    }

    private static void KeepsExtremeMeanFinite()
    {
        var timestamp = new DateTimeOffset(2026, 7, 22, 10, 0, 0, TimeSpan.Zero);
        var summary = MeasurementAggregator.Aggregate(
            [new Measurement(timestamp, double.MaxValue), new Measurement(timestamp, double.MaxValue)]).Single();

        Equal(double.MaxValue, summary.Mean);
    }

    private static WindowSummary[] ReadAndAggregate(string input) =>
        MeasurementAggregator.Aggregate(MeasurementCsv.Read(new StringReader(input))).ToArray();

    private static void Equal<T>(T expected, T actual)
        where T : notnull
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"Expected {expected}, got {actual}.");
        }
    }

    private static void Near(double expected, double actual)
    {
        if (Math.Abs(expected - actual) > 1e-12)
        {
            throw new InvalidOperationException($"Expected {expected}, got {actual}.");
        }
    }

    private static void Throws<TException>(Action action, string expectedMessage)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException exception) when (exception.Message.Contains(expectedMessage, StringComparison.Ordinal))
        {
            return;
        }

        throw new InvalidOperationException($"Expected {typeof(TException).Name} containing '{expectedMessage}'.");
    }
}
